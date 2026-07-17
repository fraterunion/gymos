import type { INestApplication } from '@nestjs/common';
import { BookingStatus, ClassStatus, Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createActiveSubscription,
  createClassTemplate,
  createConfirmedBooking,
  createMembership,
  createMembershipPlanForStudio,
  createScheduledClass,
  createStudio,
  createUserWithPassword,
} from './helpers/factories';

async function loginAccessToken(
  app: INestApplication,
  email: string,
  password: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

function periodBounds(now = new Date()) {
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}

describe('Membership usage (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedFlex8Member(studioId: string) {
    const plan = await prisma.membershipPlan.create({
      data: {
        studioId,
        name: 'Flex 8',
        priceCents: 8000,
        currency: 'usd',
        billingInterval: 'MONTHLY',
        active: true,
        classCredits: 8,
      },
    });
    const member = await createUserWithPassword(prisma, { email: `flex-${Date.now()}@e2e.local` });
    await createMembership(prisma, member.id, studioId, Role.MEMBER);
    const { start, end } = periodBounds();
    await prisma.subscription.create({
      data: {
        studioId,
        userId: member.id,
        membershipPlanId: plan.id,
        status: 'ACTIVE',
        currentPeriodStart: start,
        currentPeriodEnd: end,
      },
    });
    return { member, plan };
  }

  it('manual walk-in consumes one credit on Flex 8', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { member } = await seedFlex8Member(studio.id);
    const owner = await createUserWithPassword(prisma, { email: 'flex-owner@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    const startsAt = new Date();
    startsAt.setUTCDate(10);
    startsAt.setUTCHours(12, 0, 0, 0);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt, endsAt });

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/manual-attendance`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ memberId: member.id })
      .expect(201);

    const profile = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const body = profile.body as {
      activeSubscription: { creditsUsed: number; creditsRemaining: number };
    };
    expect(body.activeSubscription.creditsUsed).toBe(1);
    expect(body.activeSubscription.creditsRemaining).toBe(7);
  });

  it('booking + attendance for same class consumes only one credit', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { member } = await seedFlex8Member(studio.id);
    const owner = await createUserWithPassword(prisma, { email: 'dedup-owner@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    const startsAt = new Date();
    startsAt.setUTCDate(12);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt, endsAt });
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/manual`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ bookingId: booking.id })
      .expect(201);

    const profile = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const body = profile.body as {
      activeSubscription: { creditsUsed: number; creditsRemaining: number };
    };
    expect(body.activeSubscription.creditsUsed).toBe(1);
    expect(body.activeSubscription.creditsRemaining).toBe(7);
  });

  it('rejects walk-in when credits exhausted', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { member } = await seedFlex8Member(studio.id);
    const owner = await createUserWithPassword(prisma, { email: 'exhaust-owner@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    for (let day = 1; day <= 8; day++) {
      const startsAt = new Date();
      startsAt.setUTCDate(day);
      startsAt.setUTCHours(10, 0, 0, 0);
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt, endsAt });
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/manual-attendance`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ memberId: member.id })
        .expect(201);
    }

    const startsAt = new Date();
    startsAt.setUTCDate(20);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const extraClass = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt, endsAt });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${extraClass.id}/manual-attendance`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ memberId: member.id })
      .expect(400);

    expect(String((res.body as { message: unknown }).message)).toContain('credits exhausted');
  });

  it('rejects booking after walk-ins exhaust credits', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { member } = await seedFlex8Member(studio.id);
    const owner = await createUserWithPassword(prisma, { email: 'book-block-owner@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);
    const memberToken = await loginAccessToken(app, member.email, member.password);

    for (let day = 1; day <= 8; day++) {
      const startsAt = new Date();
      startsAt.setUTCDate(day);
      startsAt.setUTCHours(11, 0, 0, 0);
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt, endsAt });
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/manual-attendance`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ memberId: member.id })
        .expect(201);
    }

    const futureStart = new Date();
    futureStart.setUTCDate(25);
    futureStart.setUTCHours(14, 0, 0, 0);
    const futureEnd = new Date(futureStart.getTime() + 60 * 60 * 1000);
    const futureClass = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: futureStart,
      endsAt: futureEnd,
    });

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${futureClass.id}/bookings`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(403);
  });

  it('cancelled booking does not consume credit', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { member } = await seedFlex8Member(studio.id);
    const owner = await createUserWithPassword(prisma, { email: 'cancel-owner@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    const startsAt = new Date();
    startsAt.setUTCDate(14);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt, endsAt });
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { status: BookingStatus.CANCELLED, cancelledAt: new Date() },
    });

    const profile = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const body = profile.body as {
      activeSubscription: { creditsUsed: number; creditsRemaining: number };
    };
    expect(body.activeSubscription.creditsUsed).toBe(0);
    expect(body.activeSubscription.creditsRemaining).toBe(8);
  });

  it('two walk-ins for different classes consume two credits', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { member } = await seedFlex8Member(studio.id);
    const owner = await createUserWithPassword(prisma, { email: 'two-walk-owner@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    for (const day of [3, 4]) {
      const startsAt = new Date();
      startsAt.setUTCDate(day);
      startsAt.setUTCHours(9, 0, 0, 0);
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt, endsAt });
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/manual-attendance`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ memberId: member.id })
        .expect(201);
    }

    const profile = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const body = profile.body as {
      activeSubscription: { creditsUsed: number; creditsRemaining: number };
    };
    expect(body.activeSubscription.creditsUsed).toBe(2);
    expect(body.activeSubscription.creditsRemaining).toBe(6);
  });

  it('allows walk-in on final available credit', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { member } = await seedFlex8Member(studio.id);
    const owner = await createUserWithPassword(prisma, { email: 'final-credit-owner@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    for (let day = 1; day <= 7; day++) {
      const startsAt = new Date();
      startsAt.setUTCDate(day);
      startsAt.setUTCHours(8, 0, 0, 0);
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt, endsAt });
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/manual-attendance`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ memberId: member.id })
        .expect(201);
    }

    const startsAt = new Date();
    startsAt.setUTCDate(8);
    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const lastClass = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt, endsAt });

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${lastClass.id}/manual-attendance`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ memberId: member.id })
      .expect(201);

    const profile = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const body = profile.body as {
      activeSubscription: { creditsUsed: number; creditsRemaining: number };
    };
    expect(body.activeSubscription.creditsUsed).toBe(8);
    expect(body.activeSubscription.creditsRemaining).toBe(0);
  });

  it('unlimited plan walk-in does not enforce credit limit', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const plan = await prisma.membershipPlan.create({
      data: {
        studioId: studio.id,
        name: 'Unlimited',
        priceCents: 12000,
        currency: 'usd',
        billingInterval: 'MONTHLY',
        active: true,
        classCredits: null,
      },
    });
    const member = await createUserWithPassword(prisma, { email: 'unlimited-member@e2e.local' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const { start, end } = periodBounds();
    await prisma.subscription.create({
      data: {
        studioId: studio.id,
        userId: member.id,
        membershipPlanId: plan.id,
        status: 'ACTIVE',
        currentPeriodStart: start,
        currentPeriodEnd: end,
      },
    });
    const owner = await createUserWithPassword(prisma, { email: 'unlimited-owner@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    for (let day = 1; day <= 10; day++) {
      const startsAt = new Date();
      startsAt.setUTCDate(day);
      startsAt.setUTCHours(7, 0, 0, 0);
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt, endsAt });
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/manual-attendance`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ memberId: member.id })
        .expect(201);
    }

    const profile = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const body = profile.body as {
      activeSubscription: { creditsUsed: number | null; creditsRemaining: number | null };
    };
    expect(body.activeSubscription.creditsUsed).toBe(0);
    expect(body.activeSubscription.creditsRemaining).toBeNull();
  });

  it('concurrent walk-ins cannot exceed plan limit', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { member } = await seedFlex8Member(studio.id);
    const owner = await createUserWithPassword(prisma, { email: 'concurrent-owner@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    for (let day = 1; day <= 7; day++) {
      const startsAt = new Date();
      startsAt.setUTCDate(day);
      startsAt.setUTCHours(6, 0, 0, 0);
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt, endsAt });
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/manual-attendance`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ memberId: member.id })
        .expect(201);
    }

    const classAStart = new Date();
    classAStart.setUTCDate(8);
    classAStart.setUTCHours(6, 0, 0, 0);
    const classAEnd = new Date(classAStart.getTime() + 60 * 60 * 1000);
    const classA = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: classAStart,
      endsAt: classAEnd,
    });

    const classBStart = new Date();
    classBStart.setUTCDate(9);
    classBStart.setUTCHours(6, 0, 0, 0);
    const classBEnd = new Date(classBStart.getTime() + 60 * 60 * 1000);
    const classB = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: classBStart,
      endsAt: classBEnd,
    });

    const [resA, resB] = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${classA.id}/manual-attendance`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ memberId: member.id }),
      request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${classB.id}/manual-attendance`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ memberId: member.id }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 400]);

    const profile = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const body = profile.body as {
      activeSubscription: { creditsUsed: number; creditsRemaining: number };
    };
    expect(body.activeSubscription.creditsUsed).toBe(8);
    expect(body.activeSubscription.creditsRemaining).toBe(0);
  });

  it('historical class date counts in prior billing period', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    await prisma.membershipPlan.update({
      where: { id: plan.id },
      data: { classCredits: 8 },
    });
    const member = await createUserWithPassword(prisma, { email: 'hist-member@e2e.local' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const owner = await createUserWithPassword(prisma, { email: 'hist-owner@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    const currentStart = new Date('2025-08-01T00:00:00.000Z');
    const currentEnd = new Date('2025-09-01T00:00:00.000Z');
    await createActiveSubscription(prisma, studio.id, member.id, plan.id);
    await prisma.subscription.updateMany({
      where: { studioId: studio.id, userId: member.id },
      data: { currentPeriodStart: currentStart, currentPeriodEnd: currentEnd },
    });

    const julyClassStart = new Date('2025-07-20T12:00:00.000Z');
    const julyClassEnd = new Date(julyClassStart.getTime() + 60 * 60 * 1000);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: julyClassStart,
      endsAt: julyClassEnd,
      status: ClassStatus.COMPLETED,
    });

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/manual-attendance`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ memberId: member.id })
      .expect(201);

    const profile = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const body = profile.body as {
      activeSubscription: { creditsUsed: number; creditsRemaining: number };
    };
    // Profile displays current-period usage; July consumption is in prior period.
    expect(body.activeSubscription.creditsUsed).toBe(0);
    expect(body.activeSubscription.creditsRemaining).toBe(8);
  });
});
