import type { INestApplication } from '@nestjs/common';
import { BookingStatus, Role, WaitlistStatus } from '@prisma/client';
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

function futureClassDates() {
  const start = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

describe('Waitlist (e2e)', () => {
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

  it('allows MEMBER to join waitlist when class is full', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 1,
    });
    const holder = await createUserWithPassword(prisma, { email: 'full-holder@e2e.local' });
    const waiter = await createUserWithPassword(prisma, { email: 'waiter@e2e.local' });
    await createMembership(prisma, holder.id, studio.id, Role.MEMBER);
    await createMembership(prisma, waiter.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, holder.id, plan.id);
    await createActiveSubscription(prisma, studio.id, waiter.id, plan.id);
    await createConfirmedBooking(prisma, studio.id, cls.id, holder.id);

    const token = await loginAccessToken(app, waiter.email, waiter.password);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const body = res.body as { status: string; position: number };
    expect(body.status).toBe(WaitlistStatus.WAITING);
    expect(body.position).toBeGreaterThanOrEqual(1);
  });

  it('returns 409 when class has available spots', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 5,
    });
    const u = await createUserWithPassword(prisma, { email: 'spots@e2e.local' });
    await createMembership(prisma, u.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, u.id, plan.id);
    const token = await loginAccessToken(app, u.email, u.password);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect((res.body as { message: string }).message).toContain('available spots');
  });

  it('returns 403 when MEMBER has no subscription', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 1,
    });
    const holder = await createUserWithPassword(prisma, { email: 'h2@e2e.local' });
    const waiter = await createUserWithPassword(prisma, { email: 'w2@e2e.local' });
    await createMembership(prisma, holder.id, studio.id, Role.MEMBER);
    await createMembership(prisma, waiter.id, studio.id, Role.MEMBER);
    await createConfirmedBooking(prisma, studio.id, cls.id, holder.id);
    const token = await loginAccessToken(app, waiter.email, waiter.password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('allows INSTRUCTOR to join waitlist without subscription when class is full', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 1,
    });
    const holder = await createUserWithPassword(prisma, { email: 'h3@e2e.local' });
    const inst = await createUserWithPassword(prisma, { email: 'inst-wl@e2e.local' });
    await createMembership(prisma, holder.id, studio.id, Role.MEMBER);
    await createMembership(prisma, inst.id, studio.id, Role.INSTRUCTOR);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    await createActiveSubscription(prisma, studio.id, holder.id, plan.id);
    await createConfirmedBooking(prisma, studio.id, cls.id, holder.id);
    const token = await loginAccessToken(app, inst.email, inst.password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
  });

  it('rejects duplicate WAITING join', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 1,
    });
    const holder = await createUserWithPassword(prisma, { email: 'h4@e2e.local' });
    const waiter = await createUserWithPassword(prisma, { email: 'w4@e2e.local' });
    await createMembership(prisma, holder.id, studio.id, Role.MEMBER);
    await createMembership(prisma, waiter.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, holder.id, plan.id);
    await createActiveSubscription(prisma, studio.id, waiter.id, plan.id);
    await createConfirmedBooking(prisma, studio.id, cls.id, holder.id);
    const token = await loginAccessToken(app, waiter.email, waiter.password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('rejects join when user has CONFIRMED booking', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 2,
    });
    const a = await createUserWithPassword(prisma, { email: 'a5@e2e.local' });
    const b = await createUserWithPassword(prisma, { email: 'b5@e2e.local' });
    await createMembership(prisma, a.id, studio.id, Role.MEMBER);
    await createMembership(prisma, b.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, a.id, plan.id);
    await createActiveSubscription(prisma, studio.id, b.id, plan.id);
    await createConfirmedBooking(prisma, studio.id, cls.id, a.id);
    await createConfirmedBooking(prisma, studio.id, cls.id, b.id);
    const token = await loginAccessToken(app, a.email, a.password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('cancels waitlist entry via POST cancel', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 1,
    });
    const holder = await createUserWithPassword(prisma, { email: 'h6@e2e.local' });
    const waiter = await createUserWithPassword(prisma, { email: 'w6@e2e.local' });
    await createMembership(prisma, holder.id, studio.id, Role.MEMBER);
    await createMembership(prisma, waiter.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, holder.id, plan.id);
    await createActiveSubscription(prisma, studio.id, waiter.id, plan.id);
    await createConfirmedBooking(prisma, studio.id, cls.id, holder.id);
    const token = await loginAccessToken(app, waiter.email, waiter.password);
    const join = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const entryId = (join.body as { id: string }).id;

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/waitlist/${entryId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const row = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(row.status).toBe(WaitlistStatus.CANCELLED);
  });

  it('GET /waitlist/me returns WAITING and PROMOTED only', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 1,
    });
    const holder = await createUserWithPassword(prisma, { email: 'h7@e2e.local' });
    const waiter = await createUserWithPassword(prisma, { email: 'w7@e2e.local' });
    await createMembership(prisma, holder.id, studio.id, Role.MEMBER);
    await createMembership(prisma, waiter.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, holder.id, plan.id);
    await createActiveSubscription(prisma, studio.id, waiter.id, plan.id);
    await createConfirmedBooking(prisma, studio.id, cls.id, holder.id);
    const wTok = await loginAccessToken(app, waiter.email, waiter.password);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${wTok}`)
      .expect(201);

    const hTok = await loginAccessToken(app, holder.email, holder.password);
    const book = await prisma.booking.findFirst({
      where: { userId: holder.id, scheduledClassId: cls.id, status: BookingStatus.CONFIRMED },
    });
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/bookings/${book!.id}/cancel`)
      .set('Authorization', `Bearer ${hTok}`)
      .expect(200);

    const me = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/waitlist/me`)
      .set('Authorization', `Bearer ${wTok}`)
      .expect(200);
    const list = me.body as Array<{ status: string }>;
    expect(list.length).toBe(1);
    expect(list[0]!.status).toBe(WaitlistStatus.PROMOTED);
  });

  it('STAFF can GET class waitlist with queue ranks', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 1,
    });
    const holder = await createUserWithPassword(prisma, { email: 'h8@e2e.local' });
    const w1 = await createUserWithPassword(prisma, { email: 'w8a@e2e.local' });
    const w2 = await createUserWithPassword(prisma, { email: 'w8b@e2e.local' });
    const staff = await createUserWithPassword(prisma, { email: 'st8@e2e.local' });
    await createMembership(prisma, holder.id, studio.id, Role.MEMBER);
    await createMembership(prisma, w1.id, studio.id, Role.MEMBER);
    await createMembership(prisma, w2.id, studio.id, Role.MEMBER);
    await createMembership(prisma, staff.id, studio.id, Role.STAFF);
    await createActiveSubscription(prisma, studio.id, holder.id, plan.id);
    await createActiveSubscription(prisma, studio.id, w1.id, plan.id);
    await createActiveSubscription(prisma, studio.id, w2.id, plan.id);
    await createConfirmedBooking(prisma, studio.id, cls.id, holder.id);
    const t1 = await loginAccessToken(app, w1.email, w1.password);
    const t2 = await loginAccessToken(app, w2.email, w2.password);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${t1}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${t2}`)
      .expect(201);

    const st = await loginAccessToken(app, staff.email, staff.password);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${st}`)
      .expect(200);
    const body = res.body as Array<{ queueRank: number | null; status: string }>;
    expect(body.length).toBe(2);
    const waiting = body.filter((b) => b.status === WaitlistStatus.WAITING);
    expect(waiting.length).toBe(2);
    expect(waiting.map((w) => w.queueRank).sort()).toEqual([1, 2]);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('passwordHash');
  });
});
