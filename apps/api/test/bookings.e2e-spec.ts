import type { INestApplication } from '@nestjs/common';
import { BookingStatus, ClassStatus, Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createActiveSubscription,
  createClassTemplate,
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

describe('Bookings (e2e)', () => {
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

  it('creates CONFIRMED booking for MEMBER with ACTIVE subscription', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 10,
    });
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'book-member@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, userId, plan.id);
    const token = await loginAccessToken(app, email, password);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect((res.body as { status: string }).status).toBe(BookingStatus.CONFIRMED);
  });

  it('returns 403 when MEMBER has no ACTIVE/TRIALING subscription', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'no-sub@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('allows INSTRUCTOR to book without subscription', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'instr-book@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.INSTRUCTOR);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
  });

  it('returns 409 Already booked when second CONFIRMED for same user/class', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'dup-book@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, userId, plan.id);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(res.status).toBe(409);
    const message = (res.body as { message: string }).message;
    expect(
      message.includes('Already booked') ||
        message.includes('already have a class booked at this time'),
    ).toBe(true);
  });

  it('returns 409 when class is full', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 1,
    });
    const u1 = await createUserWithPassword(prisma, { email: 'full-a@e2e.local', password: 'password12' });
    const u2 = await createUserWithPassword(prisma, { email: 'full-b@e2e.local', password: 'password12' });
    await createMembership(prisma, u1.id, studio.id, Role.MEMBER);
    await createMembership(prisma, u2.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, u1.id, plan.id);
    await createActiveSubscription(prisma, studio.id, u2.id, plan.id);
    const t1 = await loginAccessToken(app, u1.email, u1.password);
    const t2 = await loginAccessToken(app, u2.email, u2.password);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${t1}`)
      .expect(201);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${t2}`)
      .expect(409);
    expect((res.body as { message: string }).message).toMatch(/full/i);
  });

  it('cancels via POST /bookings/:id/cancel', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'cancel-me@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, userId, plan.id);
    const token = await loginAccessToken(app, email, password);
    const book = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const bookingId = (book.body as { id: string }).id;

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(row.status).toBe(BookingStatus.CANCELLED);
  });

  it('lists upcoming CONFIRMED bookings on GET /bookings/me', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'list-me@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, userId, plan.id);
    const token = await loginAccessToken(app, email, password);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/bookings/me`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    const rows = res.body as { scheduledClass: { id: string } }[];
    expect(rows.some((b) => b.scheduledClass.id === cls.id)).toBe(true);
  });

  it('denies roster GET for MEMBER', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'mem-roster@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/classes/${cls.id}/roster`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('allows INSTRUCTOR roster GET', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const member = await createUserWithPassword(prisma, { email: 'roster-mem@e2e.local', password: 'password12' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, member.id, plan.id);
    const tm = await loginAccessToken(app, member.email, member.password);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${tm}`)
      .expect(201);

    const { id: insId, email: insEmail, password: insPw } = await createUserWithPassword(prisma, {
      email: 'roster-ins@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, insId, studio.id, Role.INSTRUCTOR);
    const ti = await loginAccessToken(app, insEmail, insPw);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/classes/${cls.id}/roster`)
      .set('Authorization', `Bearer ${ti}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as { user: { email: string } }[])[0].user.email).toBe(member.email);
  });

  it('allows STAFF roster GET', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const member = await createUserWithPassword(prisma, { email: 'roster-staff-mem@e2e.local', password: 'password12' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, member.id, plan.id);
    const tm = await loginAccessToken(app, member.email, member.password);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${tm}`)
      .expect(201);

    const { id: staffId, email: staffEmail, password: staffPw } = await createUserWithPassword(prisma, {
      email: 'roster-staff@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, staffId, studio.id, Role.STAFF);
    const st = await loginAccessToken(app, staffEmail, staffPw);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/classes/${cls.id}/roster`)
      .set('Authorization', `Bearer ${st}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as { user: { email: string } }[])[0].user.email).toBe(member.email);
  });

  it('rejects booking CANCELLED class', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      status: ClassStatus.CANCELLED,
    });
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'cxl-class@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, userId, plan.id);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('rejects booking past class', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const start = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 3600000);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'past-class@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, userId, plan.id);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('allows OWNER to view future class roster', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { id: ownerId, email, password } = await createUserWithPassword(prisma, {
      email: 'owner-future-roster@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, ownerId, studio.id, Role.OWNER);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/classes/${cls.id}/roster`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('allows ADMIN to view past class roster', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const start = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 3600000);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { id: adminId, email, password } = await createUserWithPassword(prisma, {
      email: 'admin-past-roster@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, adminId, studio.id, Role.ADMIN);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/classes/${cls.id}/roster`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('allows FRONT_DESK to view non-today class roster', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { id: deskId, email, password } = await createUserWithPassword(prisma, {
      email: 'desk-future-roster@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, deskId, studio.id, Role.FRONT_DESK);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/classes/${cls.id}/roster`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('blocks cross-studio roster access', async () => {
    const studioA = await createStudio(prisma);
    const studioB = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studioA.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studioA.id, tpl.id, { startsAt: start, endsAt: end });
    const { id: adminId, email, password } = await createUserWithPassword(prisma, {
      email: 'cross-studio-roster@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, adminId, studioB.id, Role.ADMIN);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studioA.id}/classes/${cls.id}/roster`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('excludes cancelled bookings from active roster', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = futureClassDates();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const member = await createUserWithPassword(prisma, { email: 'roster-cancel@e2e.local', password: 'password12' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, member.id, plan.id);
    const memberToken = await loginAccessToken(app, member.email, member.password);
    const bookingRes = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(201);
    const bookingId = (bookingRes.body as { id: string }).id;

    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.CANCELLED },
    });

    const { id: staffId, email: staffEmail, password: staffPw } = await createUserWithPassword(prisma, {
      email: 'roster-cancel-staff@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, staffId, studio.id, Role.STAFF);
    const staffToken = await loginAccessToken(app, staffEmail, staffPw);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/classes/${cls.id}/roster`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
    expect((res.body as unknown[]).length).toBe(0);
  });
});
