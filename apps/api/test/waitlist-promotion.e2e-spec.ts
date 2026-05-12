import type { INestApplication } from '@nestjs/common';
import { BookingStatus, Role } from '@prisma/client';
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

describe('Waitlist promotion (e2e)', () => {
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

  it('returns explicit promotion payload when cancelling frees a spot', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 1,
    });
    const holder = await createUserWithPassword(prisma, { email: 'prom-h@e2e.local' });
    const waiter = await createUserWithPassword(prisma, { email: 'prom-w@e2e.local' });
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
    const booking = await prisma.booking.findFirstOrThrow({
      where: { userId: holder.id, scheduledClassId: cls.id, status: BookingStatus.CONFIRMED },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${hTok}`)
      .expect(200);
    const body = res.body as {
      cancelled: boolean;
      promotion: { performed: true; bookingId: string; waitlistEntryId: string; userId: string } | null;
    };
    expect(body.cancelled).toBe(true);
    expect(body.promotion).not.toBeNull();
    expect(body.promotion?.performed).toBe(true);
    expect(body.promotion?.userId).toBe(waiter.id);
    expect(body.promotion?.bookingId).toBeDefined();

    const promotedBooking = await prisma.booking.findFirst({
      where: { id: body.promotion!.bookingId, status: BookingStatus.CONFIRMED },
    });
    expect(promotedBooking?.userId).toBe(waiter.id);

    const joinAgain = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/waitlist`)
      .set('Authorization', `Bearer ${wTok}`)
      .expect(409);
    expect((joinAgain.body as { message: string }).message).toMatch(/booked|waitlist/i);
  });

  it('returns cancelled:false when cancel is idempotent', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const u = await createUserWithPassword(prisma, { email: 'idem@e2e.local' });
    await createMembership(prisma, u.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, u.id, plan.id);
    const tok = await loginAccessToken(app, u.email, u.password);
    const b = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${tok}`)
      .expect(201);
    const bookingId = (b.body as { id: string }).id;

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${tok}`)
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${tok}`)
      .expect(200);
    const body = res.body as { cancelled: boolean; promotion: null };
    expect(body.cancelled).toBe(false);
    expect(body.promotion).toBeNull();
  });

  it('concurrent cancel and booking: confirmed count never exceeds capacity', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 2,
    });
    const a = await createUserWithPassword(prisma, { email: 'race-a@e2e.local' });
    const b = await createUserWithPassword(prisma, { email: 'race-b@e2e.local' });
    const c = await createUserWithPassword(prisma, { email: 'race-c@e2e.local' });
    await createMembership(prisma, a.id, studio.id, Role.MEMBER);
    await createMembership(prisma, b.id, studio.id, Role.MEMBER);
    await createMembership(prisma, c.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, a.id, plan.id);
    await createActiveSubscription(prisma, studio.id, b.id, plan.id);
    await createActiveSubscription(prisma, studio.id, c.id, plan.id);
    await createConfirmedBooking(prisma, studio.id, cls.id, a.id);
    await createConfirmedBooking(prisma, studio.id, cls.id, b.id);
    const bookingA = await prisma.booking.findFirstOrThrow({
      where: { userId: a.id, scheduledClassId: cls.id, status: BookingStatus.CONFIRMED },
    });
    const tokA = await loginAccessToken(app, a.email, a.password);
    const tokC = await loginAccessToken(app, c.email, c.password);

    const pathBook = `/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`;
    const pathCancel = `/api/v1/studios/${studio.id}/bookings/${bookingA.id}/cancel`;

    const [r1, r2] = await Promise.all([
      request(app.getHttpServer()).post(pathCancel).set('Authorization', `Bearer ${tokA}`),
      request(app.getHttpServer()).post(pathBook).set('Authorization', `Bearer ${tokC}`).send({}),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBeGreaterThanOrEqual(200);
    expect(statuses.every((s) => s === 200 || s === 201 || s === 409)).toBe(true);

    const confirmed = await prisma.booking.count({
      where: { studioId: studio.id, scheduledClassId: cls.id, status: BookingStatus.CONFIRMED },
    });
    expect(confirmed).toBeLessThanOrEqual(2);
  });
});
