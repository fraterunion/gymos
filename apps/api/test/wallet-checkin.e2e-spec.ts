import type { INestApplication } from '@nestjs/common';
import { BookingStatus, ClassStatus, Role, SubscriptionStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { WalletCredentialService } from '../src/wallet/wallet-credential.service';
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

async function loginAccessToken(app: INestApplication, email: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

/** Class starts in 10 minutes — inside the default 15-minute pre-start check-in window. */
function classTimesWithinCheckInWindow() {
  const start = new Date(Date.now() + 10 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

/** Class started 45 minutes ago — outside the fixed 30-minute post-start check-in window. */
function classTimesOutsideCheckInWindow() {
  const start = new Date(Date.now() - 45 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

describe('Wallet smart-booking check-in (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletCredentials: WalletCredentialService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    walletCredentials = app.get(WalletCredentialService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function setupMemberAndStaff(studioId: string, memberEmailPrefix: string) {
    const member = await createUserWithPassword(prisma, { email: `${memberEmailPrefix}-mem@e2e.local` });
    const staffUser = await createUserWithPassword(prisma, { email: `${memberEmailPrefix}-staff@e2e.local` });
    await createMembership(prisma, member.id, studioId, Role.MEMBER);
    await createMembership(prisma, staffUser.id, studioId, Role.STAFF);
    const staffToken = await loginAccessToken(app, staffUser.email, staffUser.password);
    return { member, staffUser, staffToken };
  }

  it('checks in via Wallet credential when exactly one eligible booking exists', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { member, staffToken } = await setupMemberAndStaff(studio.id, 'one');
    await createConfirmedBooking(prisma, studio.id, cls.id, member.id);

    const { rawCredential } = await walletCredentials.issue(studio.id, member.id);
    expect(rawCredential).toBeTruthy();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: `gymos:v1:${rawCredential}` })
      .expect(201);

    const body = res.body as { checkInMethod: string; userId: string };
    expect(body.userId).toBe(member.id);

    const attendance = await prisma.attendance.findUnique({
      where: { scheduledClassId_userId: { scheduledClassId: cls.id, userId: member.id } },
    });
    expect(attendance).not.toBeNull();

    const credentialRow = await prisma.walletCredential.findFirst({ where: { studioId: studio.id, userId: member.id } });
    expect(credentialRow?.lastUsedAt).not.toBeNull();
  });

  it('returns WALLET_NO_ELIGIBLE_BOOKING when the member has no bookings at all', async () => {
    const studio = await createStudio(prisma);
    const { member, staffToken } = await setupMemberAndStaff(studio.id, 'zero');
    const { rawCredential } = await walletCredentials.issue(studio.id, member.id);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: `gymos:v1:${rawCredential}` })
      .expect(409);
    expect(String((res.body as { message: unknown }).message)).toContain('WALLET_NO_ELIGIBLE_BOOKING');
  });

  it('a cancelled booking is not an eligible candidate (falls through to WALLET_NO_ELIGIBLE_BOOKING)', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { member, staffToken } = await setupMemberAndStaff(studio.id, 'cancelled-booking');
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    await prisma.booking.update({ where: { id: booking.id }, data: { status: BookingStatus.CANCELLED } });
    const { rawCredential } = await walletCredentials.issue(studio.id, member.id);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: `gymos:v1:${rawCredential}` })
      .expect(409);
  });

  it('a cancelled class is not an eligible candidate', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end, status: ClassStatus.CANCELLED });
    const { member, staffToken } = await setupMemberAndStaff(studio.id, 'cancelled-class');
    await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const { rawCredential } = await walletCredentials.issue(studio.id, member.id);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: `gymos:v1:${rawCredential}` })
      .expect(409);
  });

  it('a booking outside the check-in window is not an eligible candidate', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesOutsideCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { member, staffToken } = await setupMemberAndStaff(studio.id, 'outside-window');
    await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const { rawCredential } = await walletCredentials.issue(studio.id, member.id);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: `gymos:v1:${rawCredential}` })
      .expect(409);
    expect(String((res.body as { message: unknown }).message)).toContain('WALLET_NO_ELIGIBLE_BOOKING');
  });

  it('returns WALLET_ALREADY_CHECKED_IN, not WALLET_NO_ELIGIBLE_BOOKING, for a repeat scan', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { member, staffToken } = await setupMemberAndStaff(studio.id, 'already-in');
    await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const { rawCredential } = await walletCredentials.issue(studio.id, member.id);
    const barcode = `gymos:v1:${rawCredential}`;

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: barcode })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: barcode })
      .expect(409);
    expect(String((res.body as { message: unknown }).message)).toContain('WALLET_ALREADY_CHECKED_IN');
  });

  it('back-to-back bookings with a widened checkInWindowMinutes produce WALLET_MULTIPLE_ELIGIBLE_BOOKINGS — never auto-picks one', async () => {
    const studio = await createStudio(prisma);
    // Phase B finding: overlap prevention blocks class-TIME overlap, not check-in-WINDOW
    // overlap. Two back-to-back classes (A ends exactly when B starts) never collide at
    // booking time, but with checkInWindowMinutes >= 30 their check-in windows do overlap
    // at the boundary — this must resolve to an explicit ambiguity, never a guess.
    await prisma.studio.update({ where: { id: studio.id }, data: { checkInWindowMinutes: 30 } });
    // Short (20-min) classes: with checkInWindowMinutes=30 + the fixed 30-min late grace,
    // each check-in window is 60 minutes wide. Two back-to-back 20-min classes are only
    // 20 minutes apart at the boundary, so their 60-minute-wide windows overlap across a
    // real 40-minute range — not just a single instant — making this reliable to hit with
    // a real HTTP request rather than racing a timing boundary.
    const tpl = await createClassTemplate(prisma, studio.id, { name: 'Calirox', durationMinutes: 20 });
    const now = Date.now();
    const aStart = new Date(now - 5 * 60 * 1000); // started 5 min ago — within the late grace
    const aEnd = new Date(aStart.getTime() + 20 * 60 * 1000);
    const bStart = aEnd; // back-to-back, adjacent — legal under booking-overlap rules
    const bEnd = new Date(bStart.getTime() + 20 * 60 * 1000);
    const classA = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: aStart, endsAt: aEnd });
    const classB = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: bStart, endsAt: bEnd });
    const { member, staffToken } = await setupMemberAndStaff(studio.id, 'overlap');
    const bookingA = await createConfirmedBooking(prisma, studio.id, classA.id, member.id);
    const bookingB = await createConfirmedBooking(prisma, studio.id, classB.id, member.id);
    const { rawCredential } = await walletCredentials.issue(studio.id, member.id);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: `gymos:v1:${rawCredential}` })
      .expect(409);

    const body = res.body as { code: string; memberName: string; candidates: Array<{ bookingId: string }> };
    expect(body.code).toBe('WALLET_MULTIPLE_ELIGIBLE_BOOKINGS');
    // Safe to include (see check-ins.service.ts) — lets Front Desk's disambiguation UI say
    // "Selecciona la clase de <name>" instead of a bare, unlabeled list of times.
    expect(body.memberName).toBe('E2E User');
    expect(body.candidates.map((c) => c.bookingId).sort()).toEqual([bookingA.id, bookingB.id].sort());

    const attendanceCount = await prisma.attendance.count({ where: { studioId: studio.id, userId: member.id } });
    expect(attendanceCount).toBe(0);
  });

  it('rejects a revoked credential distinctly from an unknown one', async () => {
    const studio = await createStudio(prisma);
    const { member, staffToken } = await setupMemberAndStaff(studio.id, 'revoked');
    const { rawCredential } = await walletCredentials.issue(studio.id, member.id);
    await walletCredentials.revoke(studio.id, member.id);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: `gymos:v1:${rawCredential}` })
      .expect(401);
    expect(String((res.body as { message: unknown }).message)).toContain('WALLET_CREDENTIAL_REVOKED');
  });

  it('rejects an unknown/malformed credential', async () => {
    const studio = await createStudio(prisma);
    const { staffToken } = await setupMemberAndStaff(studio.id, 'malformed');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: `gymos:v1:${'x'.repeat(40)}` })
      .expect(401);
    expect(String((res.body as { message: unknown }).message)).toContain('WALLET_CREDENTIAL_INVALID');
  });

  it('rejects a credential scanned at a different studio than it was issued for', async () => {
    const studioA = await createStudio(prisma);
    const studioB = await createStudio(prisma);
    const { member } = await setupMemberAndStaff(studioA.id, 'cross-a');
    const staffB = await createUserWithPassword(prisma, { email: 'cross-b-staff@e2e.local' });
    await createMembership(prisma, staffB.id, studioB.id, Role.STAFF);
    const staffBToken = await loginAccessToken(app, staffB.email, staffB.password);
    const { rawCredential } = await walletCredentials.issue(studioA.id, member.id);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studioB.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffBToken}`)
      .send({ qrToken: `gymos:v1:${rawCredential}` })
      .expect(403);
    expect(String((res.body as { message: unknown }).message)).toContain('WALLET_WRONG_STUDIO');
  });

  it('rejects a credential whose StudioMembership was soft-deleted', async () => {
    const studio = await createStudio(prisma);
    const { member, staffToken } = await setupMemberAndStaff(studio.id, 'inactive');
    const { rawCredential } = await walletCredentials.issue(studio.id, member.id);
    await prisma.studioMembership.updateMany({
      where: { studioId: studio.id, userId: member.id },
      data: { deletedAt: new Date() },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: `gymos:v1:${rawCredential}` })
      .expect(403);
    expect(String((res.body as { message: unknown }).message)).toContain('WALLET_MEMBER_NOT_ACTIVE');
  });

  it('forbids a MEMBER-role token from performing a Wallet scan (RBAC unchanged)', async () => {
    const studio = await createStudio(prisma);
    const other = await createUserWithPassword(prisma, { email: 'rbac-scanner@e2e.local' });
    await createMembership(prisma, other.id, studio.id, Role.MEMBER);
    const memberToken = await loginAccessToken(app, other.email, other.password);
    const { rawCredential } = await walletCredentials.issue(studio.id, other.id);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ qrToken: `gymos:v1:${rawCredential}` })
      .expect(403);
  });

  it('concurrent Wallet scans of the same booking: one succeeds, one conflicts, single attendance row', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { start, end } = classTimesWithinCheckInWindow();
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
    const { member, staffToken } = await setupMemberAndStaff(studio.id, 'concurrent-wallet');
    await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const { rawCredential } = await walletCredentials.issue(studio.id, member.id);
    const barcode = `gymos:v1:${rawCredential}`;

    const path = `/api/v1/studios/${studio.id}/check-ins/qr`;
    const [first, second] = await Promise.all([
      request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${staffToken}`).send({ qrToken: barcode }),
      request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${staffToken}`).send({ qrToken: barcode }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);

    const count = await prisma.attendance.count({
      where: { studioId: studio.id, scheduledClassId: cls.id, userId: member.id },
    });
    expect(count).toBe(1);
  });

  describe('entitlement-after-booking parity (CTO Correction 2)', () => {
    /**
     * Same scenario run three ways — booking QR, manual, Wallet — must produce the SAME
     * outcome (allowed) because canonical check-in eligibility has never re-checked
     * subscription entitlement once a booking is CONFIRMED. Wallet must not invent a
     * stricter rule the other two paths don't enforce.
     */
    async function setupConfirmedBookingThenLapsedEntitlement(labelPrefix: string) {
      const studio = await createStudio(prisma);
      const tpl = await createClassTemplate(prisma, studio.id);
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const { start, end } = classTimesWithinCheckInWindow();
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
      const member = await createUserWithPassword(prisma, { email: `${labelPrefix}-mem@e2e.local` });
      const staffUser = await createUserWithPassword(prisma, { email: `${labelPrefix}-staff@e2e.local` });
      await createMembership(prisma, member.id, studio.id, Role.MEMBER);
      await createMembership(prisma, staffUser.id, studio.id, Role.STAFF);

      // Entitled at booking time.
      const subscription = await createActiveSubscription(prisma, studio.id, member.id, plan.id);
      const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);

      // Entitlement changes AFTER the booking was already CONFIRMED.
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: SubscriptionStatus.CANCELED },
      });

      const staffToken = await loginAccessToken(app, staffUser.email, staffUser.password);
      return { studio, cls, member, booking, staffToken };
    }

    it('booking QR check-in still succeeds after entitlement lapses', async () => {
      const { studio, booking, staffToken } = await setupConfirmedBookingThenLapsedEntitlement('parity-qr');
      const ownerLikeToken = staffToken; // staff generates on member's behalf is not allowed; use booking owner's own token instead
      void ownerLikeToken;
      // QR must be requested by the booking owner — log in as the member.
      const memberRow = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id }, include: { user: true } });
      // Re-derive a login for the member (password known via factory default).
      const memberToken = await loginAccessToken(app, memberRow.user.email, 'password12');

      const qrRes = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/bookings/${booking.id}/qr`)
        .set('Authorization', `Bearer ${memberToken}`)
        .expect(201);
      const { qrToken } = qrRes.body as { qrToken: string };

      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ qrToken })
        .expect(201);
    });

    it('manual check-in still succeeds after entitlement lapses', async () => {
      const { studio, booking, staffToken } = await setupConfirmedBookingThenLapsedEntitlement('parity-manual');

      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/check-ins/manual`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ bookingId: booking.id })
        .expect(201);
    });

    it('Wallet check-in still succeeds after entitlement lapses — identical outcome to QR and manual', async () => {
      const { studio, member, staffToken } = await setupConfirmedBookingThenLapsedEntitlement('parity-wallet');
      const { rawCredential } = await walletCredentials.issue(studio.id, member.id);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/check-ins/qr`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ qrToken: `gymos:v1:${rawCredential}` })
        .expect(201);
      expect((res.body as { userId: string }).userId).toBe(member.id);
    });
  });
});
