import type { INestApplication } from '@nestjs/common';
import { CheckInMethod, Role } from '@prisma/client';
import { createHash } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createClassTemplate,
  createConfirmedBooking,
  createMembership,
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

/** Class starts in 10 minutes — inside the 15-minute pre-start check-in window. */
function classTimesWithinCheckInWindow() {
  const start = new Date(Date.now() + 10 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

function classTimesOutsideCheckInWindow() {
  const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

describe('Check-ins (e2e)', () => {
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

  it('allows booking owner to generate QR', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const owner = await createUserWithPassword(prisma, { email: 'owner-qr@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.MEMBER);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, owner.id);
    const token = await loginAccessToken(app, owner.email, owner.password);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/bookings/${booking.id}/qr`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const body = res.body as { qrToken: string; expiresAt: string };
    expect(typeof body.qrToken).toBe('string');
    expect(body.qrToken.length).toBeGreaterThan(20);
    expect(body.expiresAt).toBeDefined();
    const stored = await prisma.qRToken.findFirst({ where: { studioId: studio.id } });
    expect(stored?.tokenHash).toBeDefined();
    expect(stored?.tokenHash).toBe(createHash('sha256').update(body.qrToken, 'utf8').digest('hex'));
  });

  it('forbids another member from generating QR for someone else booking', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const owner = await createUserWithPassword(prisma, { email: 'owner2@e2e.local' });
    const other = await createUserWithPassword(prisma, { email: 'other2@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.MEMBER);
    await createMembership(prisma, other.id, studio.id, Role.MEMBER);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, owner.id);
    const otherToken = await loginAccessToken(app, other.email, other.password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/bookings/${booking.id}/qr`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);
  });

  it('allows staff to validate QR and create attendance', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const owner = await createUserWithPassword(prisma, { email: 'mem-qr@e2e.local' });
    const staffUser = await createUserWithPassword(prisma, { email: 'staff-qr@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.MEMBER);
    await createMembership(prisma, staffUser.id, studio.id, Role.STAFF);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, owner.id);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);
    const staffToken = await loginAccessToken(app, staffUser.email, staffUser.password);

    const qrRes = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/bookings/${booking.id}/qr`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);
    const { qrToken } = qrRes.body as { qrToken: string };

    const inRes = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken })
      .expect(201);
    const body = inRes.body as { checkInMethod: string; userId: string; user: { email: string } };
    expect(body.checkInMethod).toBe(CheckInMethod.QR);
    expect(body.userId).toBe(owner.id);
    expect(body.user.email).toBe(owner.email);

    const qrRow = await prisma.qRToken.findFirst({ where: { studioId: studio.id } });
    expect(qrRow?.usedAt).not.toBeNull();
  });

  it('returns 409 when reusing a QR after successful check-in', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const owner = await createUserWithPassword(prisma, { email: 'reuse-qr@e2e.local' });
    const staffUser = await createUserWithPassword(prisma, { email: 'staff-reuse@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.MEMBER);
    await createMembership(prisma, staffUser.id, studio.id, Role.STAFF);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, owner.id);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);
    const staffToken = await loginAccessToken(app, staffUser.email, staffUser.password);

    const { qrToken } = (
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/bookings/${booking.id}/qr`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(201)
    ).body as { qrToken: string };

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken })
      .expect(201);

    const dup = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken })
      .expect(409);
    expect(String((dup.body as { message: unknown }).message)).toContain('QR token already used or expired');
  });

  it('rejects expired QR when DB expiresAt is in the past', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const owner = await createUserWithPassword(prisma, { email: 'exp-qr@e2e.local' });
    const staffUser = await createUserWithPassword(prisma, { email: 'staff-exp@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.MEMBER);
    await createMembership(prisma, staffUser.id, studio.id, Role.STAFF);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, owner.id);

    const secret = process.env['JWT_QR_SECRET']!;
    const raw = jwt.sign(
      { sub: owner.id, studioId: studio.id, bookingId: booking.id, jti: 'exp-test' },
      secret,
      { algorithm: 'HS256', expiresIn: '2h' },
    );
    const tokenHash = createHash('sha256').update(raw, 'utf8').digest('hex');
    await prisma.qRToken.create({
      data: {
        studioId: studio.id,
        tokenHash,
        userId: owner.id,
        scheduledClassId: cls.id,
        expiresAt: new Date(Date.now() - 120_000),
      },
    });

    const staffToken = await loginAccessToken(app, staffUser.email, staffUser.password);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: raw })
      .expect(409);
    expect(String((res.body as { message: unknown }).message)).toContain('QR token already used or expired');
  });

  it('allows STAFF manual check-in', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const member = await createUserWithPassword(prisma, { email: 'man-mem@e2e.local' });
    const staffUser = await createUserWithPassword(prisma, { email: 'man-staff@e2e.local' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await createMembership(prisma, staffUser.id, studio.id, Role.STAFF);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const staffToken = await loginAccessToken(app, staffUser.email, staffUser.password);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/manual`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ bookingId: booking.id })
      .expect(201);
    const body = res.body as { checkInMethod: string; checkedInByUserId: string | null };
    expect(body.checkInMethod).toBe(CheckInMethod.MANUAL);
    expect(body.checkedInByUserId).toBe(staffUser.id);
  });

  it('forbids MEMBER from manual check-in', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const member = await createUserWithPassword(prisma, { email: 'mem-man@e2e.local' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const memberToken = await loginAccessToken(app, member.email, member.password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/manual`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ bookingId: booking.id })
      .expect(403);
  });

  it('returns 409 on duplicate attendance', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const member = await createUserWithPassword(prisma, { email: 'dup-mem@e2e.local' });
    const staffUser = await createUserWithPassword(prisma, { email: 'dup-staff@e2e.local' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await createMembership(prisma, staffUser.id, studio.id, Role.STAFF);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const staffToken = await loginAccessToken(app, staffUser.email, staffUser.password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/manual`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ bookingId: booking.id })
      .expect(201);

    const dup = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/manual`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ bookingId: booking.id })
      .expect(409);
    expect((dup.body as { message: string }).message).toContain('Already checked in');
  });

  it('rejects check-in outside the allowed time window', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesOutsideCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const member = await createUserWithPassword(prisma, { email: 'win-mem@e2e.local' });
    const staffUser = await createUserWithPassword(prisma, { email: 'win-staff@e2e.local' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await createMembership(prisma, staffUser.id, studio.id, Role.STAFF);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const staffToken = await loginAccessToken(app, staffUser.email, staffUser.password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/manual`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ bookingId: booking.id })
      .expect(400);
  });

  it('class attendance list exposes only safe user fields', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const member = await createUserWithPassword(prisma, { email: 'list-mem@e2e.local' });
    const staffUser = await createUserWithPassword(prisma, { email: 'list-staff@e2e.local' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await createMembership(prisma, staffUser.id, studio.id, Role.STAFF);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const staffToken = await loginAccessToken(app, staffUser.email, staffUser.password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/manual`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ bookingId: booking.id })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/classes/${cls.id}/attendance`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('stripeCustomerId');
    const list = res.body as Array<{ user: Record<string, unknown> }>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1);
    expect(Object.keys(list[0]!.user).sort()).toEqual(['email', 'firstName', 'id', 'lastName', 'phone'].sort());
  });

  it('concurrent QR scans: one succeeds, one 409, single attendance row', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const owner = await createUserWithPassword(prisma, { email: 'conc-qr@e2e.local' });
    const staffUser = await createUserWithPassword(prisma, { email: 'staff-conc@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.MEMBER);
    await createMembership(prisma, staffUser.id, studio.id, Role.STAFF);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, owner.id);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);
    const staffToken = await loginAccessToken(app, staffUser.email, staffUser.password);

    const { qrToken } = (
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/bookings/${booking.id}/qr`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(201)
    ).body as { qrToken: string };

    const path = `/api/v1/studios/${studio.id}/check-ins/qr`;
    const [first, second] = await Promise.all([
      request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${staffToken}`).send({ qrToken }),
      request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${staffToken}`).send({ qrToken }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);

    const count = await prisma.attendance.count({
      where: { studioId: studio.id, scheduledClassId: cls.id, userId: owner.id },
    });
    expect(count).toBe(1);
  });
});
