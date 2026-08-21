import type { INestApplication } from '@nestjs/common';
import { BookingStatus, ClassStatus, Role } from '@prisma/client';
import request from 'supertest';
import { MEMBER_ERRORS } from '../src/member-facing/member-errors';
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
    expect(message).toBe(MEMBER_ERRORS.alreadyBooked);
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
    expect((res.body as { message: string }).message).toBe(MEMBER_ERRORS.classFull);
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

  describe('member booking time overlap', () => {
    async function memberWithSub(studioId: string, email: string) {
      const plan = await createMembershipPlanForStudio(prisma, studioId);
      const user = await createUserWithPassword(prisma, { email, password: 'password12' });
      await createMembership(prisma, user.id, studioId, Role.MEMBER);
      await createActiveSubscription(prisma, studioId, user.id, plan.id);
      const token = await loginAccessToken(app, user.email, user.password);
      return { user, token };
    }

    it('allows adjacent back-to-back classes (07:00–08:00 then 08:00–09:00)', async () => {
      const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
      const tplA = await createClassTemplate(prisma, studio.id, { name: 'Class A' });
      const tplB = await createClassTemplate(prisma, studio.id, { name: 'Class B' });
      const day = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
      day.setUTCHours(13, 0, 0, 0); // 07:00 CDMX
      const firstEnd = new Date(day.getTime() + 60 * 60 * 1000);
      const secondStart = firstEnd;
      const secondEnd = new Date(secondStart.getTime() + 60 * 60 * 1000);
      const clsA = await createScheduledClass(prisma, studio.id, tplA.id, {
        startsAt: day,
        endsAt: firstEnd,
      });
      const clsB = await createScheduledClass(prisma, studio.id, tplB.id, {
        startsAt: secondStart,
        endsAt: secondEnd,
      });
      const { token } = await memberWithSub(studio.id, 'adjacent-a@e2e.local');

      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${clsA.id}/bookings`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${clsB.id}/bookings`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
    });

    it('blocks partial overlap between CONFIRMED bookings', async () => {
      const studio = await createStudio(prisma);
      const tplA = await createClassTemplate(prisma, studio.id);
      const tplB = await createClassTemplate(prisma, studio.id);
      const start = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
      const firstEnd = new Date(start.getTime() + 60 * 60 * 1000);
      const secondStart = new Date(start.getTime() + 30 * 60 * 1000);
      const secondEnd = new Date(secondStart.getTime() + 60 * 60 * 1000);
      const clsA = await createScheduledClass(prisma, studio.id, tplA.id, {
        startsAt: start,
        endsAt: firstEnd,
      });
      const clsB = await createScheduledClass(prisma, studio.id, tplB.id, {
        startsAt: secondStart,
        endsAt: secondEnd,
      });
      const { token } = await memberWithSub(studio.id, 'overlap-block@e2e.local');

      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${clsA.id}/bookings`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${clsB.id}/bookings`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((res.body as { message: string }).message).toBe(MEMBER_ERRORS.overlap);
    });

    it('does not block after cancelling the overlapping booking', async () => {
      const studio = await createStudio(prisma);
      const tplA = await createClassTemplate(prisma, studio.id);
      const tplB = await createClassTemplate(prisma, studio.id);
      const start = new Date(Date.now() + 11 * 24 * 60 * 60 * 1000);
      const firstEnd = new Date(start.getTime() + 60 * 60 * 1000);
      const secondStart = new Date(start.getTime() + 30 * 60 * 1000);
      const secondEnd = new Date(secondStart.getTime() + 60 * 60 * 1000);
      const clsA = await createScheduledClass(prisma, studio.id, tplA.id, {
        startsAt: start,
        endsAt: firstEnd,
      });
      const clsB = await createScheduledClass(prisma, studio.id, tplB.id, {
        startsAt: secondStart,
        endsAt: secondEnd,
      });
      const { token } = await memberWithSub(studio.id, 'cancel-then-book@e2e.local');

      const booked = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${clsA.id}/bookings`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      const bookingId = (booked.body as { id: string }).id;

      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/bookings/${bookingId}/cancel`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${clsB.id}/bookings`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
    });

    it('does not block when prior CONFIRMED booking is on a CANCELLED class', async () => {
      const studio = await createStudio(prisma);
      const tplA = await createClassTemplate(prisma, studio.id);
      const tplB = await createClassTemplate(prisma, studio.id);
      const { start, end } = futureClassDates();
      const clsA = await createScheduledClass(prisma, studio.id, tplA.id, {
        startsAt: start,
        endsAt: end,
        status: ClassStatus.CANCELLED,
      });
      const clsB = await createScheduledClass(prisma, studio.id, tplB.id, {
        startsAt: start,
        endsAt: end,
      });
      const { user, token } = await memberWithSub(studio.id, 'cancelled-class@e2e.local');
      await prisma.booking.create({
        data: {
          studioId: studio.id,
          scheduledClassId: clsA.id,
          userId: user.id,
          status: BookingStatus.CONFIRMED,
        },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${clsB.id}/bookings`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
    });

    it('does not block Street Bars when member has hidden past booking on corrupt endsAt row', async () => {
      const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
      const fullBody = await createClassTemplate(prisma, studio.id, {
        name: 'Full Body',
        durationMinutes: 60,
      });
      const streetBars = await createClassTemplate(prisma, studio.id, {
        name: 'Street Bars',
        durationMinutes: 60,
      });
      const pastStart = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      pastStart.setUTCHours(12, 0, 0, 0);
      const corruptEnd = new Date(pastStart.getTime() + 304 * 24 * 60 * 60 * 1000);
      const corruptClass = await createScheduledClass(prisma, studio.id, fullBody.id, {
        startsAt: pastStart,
        endsAt: corruptEnd,
      });
      const futureStart = new Date(Date.now() + 12 * 24 * 60 * 60 * 1000);
      futureStart.setUTCHours(14, 0, 0, 0); // 08:00 CDMX
      const futureEnd = new Date(futureStart.getTime() + 60 * 60 * 1000);
      const streetClass = await createScheduledClass(prisma, studio.id, streetBars.id, {
        startsAt: futureStart,
        endsAt: futureEnd,
      });
      const { user, token } = await memberWithSub(studio.id, 'street-bars@e2e.local');
      await prisma.booking.create({
        data: {
          studioId: studio.id,
          scheduledClassId: corruptClass.id,
          userId: user.id,
          status: BookingStatus.CONFIRMED,
        },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${streetClass.id}/bookings`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
    });

    it('blocks booking a future class while member is in an in-progress class', async () => {
      const studio = await createStudio(prisma);
      const tplA = await createClassTemplate(prisma, studio.id);
      const tplB = await createClassTemplate(prisma, studio.id);
      const inProgressStart = new Date(Date.now() - 10 * 60 * 1000);
      const inProgressEnd = new Date(inProgressStart.getTime() + 60 * 60 * 1000);
      const futureStart = new Date(Date.now() + 20 * 60 * 1000);
      const futureEnd = new Date(futureStart.getTime() + 60 * 60 * 1000);
      const clsA = await createScheduledClass(prisma, studio.id, tplA.id, {
        startsAt: inProgressStart,
        endsAt: inProgressEnd,
      });
      const clsB = await createScheduledClass(prisma, studio.id, tplB.id, {
        startsAt: futureStart,
        endsAt: futureEnd,
      });
      const { user, token } = await memberWithSub(studio.id, 'in-progress@e2e.local');
      await prisma.booking.create({
        data: {
          studioId: studio.id,
          scheduledClassId: clsA.id,
          userId: user.id,
          status: BookingStatus.CONFIRMED,
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${clsB.id}/bookings`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
      expect((res.body as { message: string }).message).toBe(MEMBER_ERRORS.overlap);
    });
  });
});
