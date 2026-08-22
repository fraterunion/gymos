import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
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

/**
 * PHASE 3.1 canonicalization proof: booking QR, /check-ins/manual, Wallet check-in, and
 * staff force check-in (members/:userId/bookings/:bookingId/check-in) all now write through
 * the same CheckInsService.performCheckIn core (staff force delegates to checkInManual as of
 * this phase — see MembersService.staffForceCheckIn). The strongest behavioral proof that two
 * HTTP routes share one write path is cross-path duplicate rejection: if route A creates the
 * Attendance row and route B on the SAME booking is rejected by the SAME unique constraint,
 * they cannot be writing through independent, divergent code.
 */
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

describe('Canonical check-in core — cross-path invariants (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  async function setup() {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const member = await createUserWithPassword(prisma, { email: `member-${Date.now()}@e2e.local` });
    const staffUser = await createUserWithPassword(prisma, { email: `staff-${Date.now()}@e2e.local` });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await createMembership(prisma, staffUser.id, studio.id, Role.STAFF);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const staffToken = await loginAccessToken(app, staffUser.email, staffUser.password);
    return { studio, member, staffUser, booking, staffToken };
  }

  it('manual check-in first, then staff force check-in on the same booking is rejected as a duplicate', async () => {
    const { studio, member, booking, staffToken } = await setup();

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/manual`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ bookingId: booking.id })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/members/${member.id}/bookings/${booking.id}/check-in`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(409);
    expect(String((res.body as { message: unknown }).message)).toContain('Already checked in');

    const attendances = await prisma.attendance.findMany({
      where: { studioId: studio.id, scheduledClassId: booking.scheduledClassId, userId: member.id },
    });
    expect(attendances).toHaveLength(1);
  });

  it('staff force check-in first, then manual check-in on the same booking is rejected as a duplicate', async () => {
    const { studio, member, booking, staffToken } = await setup();

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/members/${member.id}/bookings/${booking.id}/check-in`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/manual`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ bookingId: booking.id })
      .expect(409);
    expect(String((res.body as { message: unknown }).message)).toContain('Already checked in');

    const attendances = await prisma.attendance.findMany({
      where: { studioId: studio.id, scheduledClassId: booking.scheduledClassId, userId: member.id },
    });
    expect(attendances).toHaveLength(1);
  });

  it('staff force check-in response carries the same shape callers already depend on (method, checkedInByUserId)', async () => {
    const { studio, member, booking, staffUser, staffToken } = await setup();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/members/${member.id}/bookings/${booking.id}/check-in`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(201);

    const body = res.body as {
      success: boolean;
      attendance: { id: string; method: string; checkedInByUserId: string; userId: string };
    };
    expect(body.success).toBe(true);
    expect(body.attendance.method).toBe('MANUAL');
    expect(body.attendance.checkedInByUserId).toBe(staffUser.id);
    expect(body.attendance.userId).toBe(member.id);
  });

  it('staff force check-in is still denied for FRONT_DESK (narrower role gate preserved, unwidened by canonicalization)', async () => {
    const { studio, member, booking } = await setup();
    const frontDesk = await createUserWithPassword(prisma, { email: `fd-${Date.now()}@e2e.local` });
    await createMembership(prisma, frontDesk.id, studio.id, Role.FRONT_DESK);
    const frontDeskToken = await loginAccessToken(app, frontDesk.email, frontDesk.password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/members/${member.id}/bookings/${booking.id}/check-in`)
      .set('Authorization', `Bearer ${frontDeskToken}`)
      .expect(403);
  });
});
