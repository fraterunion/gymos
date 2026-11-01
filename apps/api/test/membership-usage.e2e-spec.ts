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

/** Timer APIs Prisma and Nest keep using while `Date` is frozen. */
const REAL_ASYNC_APIS = [
  'setTimeout',
  'clearTimeout',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'nextTick',
  'queueMicrotask',
  'hrtime',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
] as const;

/**
 * Eight class starts before `clock`, plus one booking start after `clock`, all inside the
 * UTC month that contains `clock`. A flat `clock + 3h` is not used when that instant is
 * already the next month: on 31 Oct 22:00Z that offset is 1 Nov, which correctly has a
 * fresh credit period.
 */
function samePeriodCreditInstants(clock: Date): { walkIns: Date[]; bookingStart: Date } {
  const { start, end } = periodBounds(clock);
  const span = clock.getTime() - start.getTime();
  if (span <= 8 * 60_000) {
    throw new Error(`clock ${clock.toISOString()} leaves no room for eight past classes in its billing period`);
  }
  const step = Math.floor(span / 9);
  const walkIns = Array.from({ length: 8 }, (_, index) => new Date(start.getTime() + (index + 1) * step));
  const plusThreeHours = clock.getTime() + 3 * 60 * 60 * 1000;
  const bookingMs = plusThreeHours < end.getTime() ? plusThreeHours : end.getTime() - 60_000;
  const bookingStart = new Date(bookingMs);
  if (!(bookingStart.getTime() > clock.getTime() && bookingStart < end)) {
    throw new Error(
      `booking ${bookingStart.toISOString()} is not a future class inside the period ending ${end.toISOString()}`,
    );
  }
  for (const startsAt of walkIns) {
    if (!(startsAt >= start && startsAt < clock)) {
      throw new Error(`walk-in ${startsAt.toISOString()} is not inside the period and before ${clock.toISOString()}`);
    }
  }
  return { walkIns, bookingStart };
}

async function withFrozenClock<T>(iso: string, run: (clock: Date) => Promise<T>): Promise<T> {
  jest.useFakeTimers({ doNotFake: [...REAL_ASYNC_APIS] });
  jest.setSystemTime(new Date(iso));
  try {
    return await run(new Date(iso));
  } finally {
    jest.useRealTimers();
  }
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

  async function seedFlex8Member(studioId: string, now = new Date()) {
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
    const { start, end } = periodBounds(now);
    await createActiveSubscription(prisma, studioId, member.id, plan.id, {
      currentPeriodStart: start,
      currentPeriodEnd: end,
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

    const startsAt = new Date(Date.now() - 5 * 60 * 1000);
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

    expect(String((res.body as { message: unknown }).message)).toContain('créditos');
  });

  it.each(['2026-10-31T22:00:00.000Z', '2026-11-01T02:00:00.000Z'])(
    'rejects booking after walk-ins exhaust credits at %s',
    async (clockIso) => {
      await withFrozenClock(clockIso, async (clock) => {
        const period = periodBounds(clock);
        const naiveThreeHours = new Date(clock.getTime() + 3 * 60 * 60 * 1000);
        const { walkIns, bookingStart } = samePeriodCreditInstants(clock);
        if (clockIso.startsWith('2026-10-31')) {
          expect(naiveThreeHours.getTime()).toBeGreaterThanOrEqual(period.end.getTime());
        } else {
          expect(naiveThreeHours.getTime()).toBeLessThan(period.end.getTime());
          expect(bookingStart.getTime()).toBe(naiveThreeHours.getTime());
        }
        expect(bookingStart.getTime()).toBeGreaterThan(clock.getTime());
        expect(bookingStart.getTime()).toBeLessThan(period.end.getTime());
        expect(new Date().toISOString()).toBe(clockIso);

        const studio = await createStudio(prisma);
        const tpl = await createClassTemplate(prisma, studio.id);
        const { member } = await seedFlex8Member(studio.id, clock);
        const owner = await createUserWithPassword(prisma, {
          email: `book-block-owner-${clock.getTime()}@e2e.local`,
        });
        await createMembership(prisma, owner.id, studio.id, Role.OWNER);
        const ownerToken = await loginAccessToken(app, owner.email, owner.password);
        const memberToken = await loginAccessToken(app, member.email, member.password);

        for (const startsAt of walkIns) {
          const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
            startsAt,
            endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
          });
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
        expect(
          (profile.body as { activeSubscription: { creditsUsed: number; creditsRemaining: number } })
            .activeSubscription,
        ).toMatchObject({ creditsUsed: 8, creditsRemaining: 0 });

        const futureClass = await createScheduledClass(prisma, studio.id, tpl.id, {
          startsAt: bookingStart,
          endsAt: new Date(bookingStart.getTime() + 60 * 60 * 1000),
        });
        const bookingRes = await request(app.getHttpServer())
          .post(`/api/v1/studios/${studio.id}/classes/${futureClass.id}/bookings`)
          .set('Authorization', `Bearer ${memberToken}`);
        expect(bookingRes.status).toBe(403);
        expect(String((bookingRes.body as { message?: unknown }).message ?? '')).toMatch(
          /cr[eé]dito/i,
        );
      });
    },
  );

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
    await createActiveSubscription(prisma, studio.id, member.id, plan.id, {
      currentPeriodStart: start,
      currentPeriodEnd: end,
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
    expect(body.activeSubscription.creditsUsed).toBeNull();
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

    const { start: currentStart, end: currentEnd } = periodBounds();
    await createActiveSubscription(prisma, studio.id, member.id, plan.id, {
      currentPeriodStart: currentStart,
      currentPeriodEnd: currentEnd,
    });

    const priorPeriodStart = new Date(currentStart);
    priorPeriodStart.setUTCMonth(priorPeriodStart.getUTCMonth() - 1);
    priorPeriodStart.setUTCDate(20);
    priorPeriodStart.setUTCHours(12, 0, 0, 0);
    const julyClassStart = priorPeriodStart;
    const julyClassEnd = new Date(priorPeriodStart.getTime() + 60 * 60 * 1000);
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
