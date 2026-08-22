import type { INestApplication } from '@nestjs/common';
import {
  BillingInterval,
  BookingStatus,
  CheckInType,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import request from 'supertest';
import { getStudioLocalHHmm } from '../src/common/date/studio-local-date';
import { MembershipUsageService } from '../src/membership-usage/membership-usage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildWalletCredentialBarcode } from '../src/wallet/wallet-credential.constants';
import { WalletCredentialService } from '../src/wallet/wallet-credential.service';
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
 * Open Gym facility access at the Front Desk.
 *
 * A scan is first a request to enter the building; a class check-in is the special case where
 * the member happens to have booked something starting now. These tests pin both halves: that
 * an entitled member without a reservation gets in, and that doing so never leaks into class
 * state (roster, capacity, credits, no-show).
 *
 * Hour windows are built RELATIVE to the studio's current local time rather than hardcoded, so
 * the suite is deterministic at every hour of the day and in any CI timezone. The exact ARES
 * clock scenarios (Basic at 12:00 and 22:30, Open Gym plan at 16:30 and 18:00) are pinned
 * against fixed UTC instants in src/check-ins/open-gym-access.spec.ts.
 */

const DEDUPE_MINUTES = 3;

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

/** Studio-local 'HH:mm' shifted by a number of minutes from the given instant. */
function localOffsetHHmm(now: Date, timezone: string, deltaMinutes: number): string {
  return getStudioLocalHHmm(new Date(now.getTime() + deltaMinutes * 60_000), timezone);
}

/** A window that currently contains the studio-local time. */
function windowContainingNow(now: Date, timezone: string) {
  return {
    openGymWindowStart: localOffsetHHmm(now, timezone, -60),
    openGymWindowEnd: localOffsetHHmm(now, timezone, 60),
  };
}

/** A window that starts an hour from now, so the present moment is outside it. */
function windowAfterNow(now: Date, timezone: string) {
  return {
    openGymWindowStart: localOffsetHHmm(now, timezone, 60),
    openGymWindowEnd: localOffsetHHmm(now, timezone, 180),
  };
}

describe('Open Gym facility access (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletCredentials: WalletCredentialService;
  let membershipUsage: MembershipUsageService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    walletCredentials = app.get(WalletCredentialService);
    membershipUsage = app.get(MembershipUsageService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  type PlanShape = {
    name: string;
    openGymAccess: boolean;
    openGymWindowStart?: string | null;
    openGymWindowEnd?: string | null;
    classCredits?: number | null;
  };

  async function setupScenario(
    planShape: PlanShape,
    opts: { timezone?: string; subscriptionExpired?: boolean } = {},
  ) {
    const timezone = opts.timezone ?? 'America/Mexico_City';
    const studio = await createStudio(prisma, { timezone });
    const template = await createClassTemplate(prisma, studio.id);

    const plan = await prisma.membershipPlan.create({
      data: {
        studioId: studio.id,
        name: planShape.name,
        priceCents: 130000,
        currency: 'mxn',
        billingInterval: BillingInterval.MONTHLY,
        active: true,
        classCredits: planShape.classCredits ?? null,
        allClassesAccess: true,
        openGymAccess: planShape.openGymAccess,
        openGymWindowStart: planShape.openGymWindowStart ?? null,
        openGymWindowEnd: planShape.openGymWindowEnd ?? null,
      },
    });

    const member = await createUserWithPassword(prisma);
    const staff = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await createMembership(prisma, staff.id, studio.id, Role.FRONT_DESK);

    const now = new Date();
    await prisma.subscription.create({
      data: {
        studioId: studio.id,
        userId: member.id,
        membershipPlanId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: new Date(now.getTime() - 5 * 86_400_000),
        currentPeriodEnd: opts.subscriptionExpired
          ? new Date(now.getTime() - 86_400_000)
          : new Date(now.getTime() + 25 * 86_400_000),
      },
    });

    const { rawCredential } = await walletCredentials.issue(studio.id, member.id);
    const staffToken = await loginAccessToken(app, staff.email, staff.password);

    return {
      studio,
      template,
      plan,
      member,
      staff,
      staffToken,
      barcode: buildWalletCredentialBarcode(rawCredential!),
      timezone,
    };
  }

  function scan(studioId: string, staffToken: string, barcode: string) {
    return request(app.getHttpServer())
      .post(`/api/v1/studios/${studioId}/check-ins/qr`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ qrToken: barcode });
  }

  /** A class whose check-in window is open right now (starts in 10 minutes). */
  function classStartingSoon() {
    const startsAt = new Date(Date.now() + 10 * 60_000);
    return { startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000) };
  }

  function openGymPlanShape(now: Date, timezone: string, name = 'Basic Access'): PlanShape {
    return { name, openGymAccess: true, ...windowContainingNow(now, timezone) };
  }

  // ── Case D: entitled member, no applicable reservation ────────────────────────────────

  it('checks an entitled member into Open Gym when they have no reservation', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));

    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
    const body = res.body as {
      type: string;
      scheduledClassId: string | null;
      openGym: { membershipPlanName: string; deduplicated: boolean; classInProgress: unknown };
    };

    expect(body.type).toBe('OPEN_GYM');
    expect(body.scheduledClassId).toBeNull();
    expect(body.openGym.membershipPlanName).toBe('Basic Access');
    expect(body.openGym.deduplicated).toBe(false);
    expect(body.openGym.classInProgress).toBeNull();

    const rows = await prisma.attendance.findMany({ where: { studioId: ctx.studio.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe(CheckInType.OPEN_GYM);
    expect(rows[0]!.scheduledClassId).toBeNull();
  });

  it('reports a class in progress as secondary context without joining the member to it', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    const { startsAt, endsAt } = classStartingSoon();
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt,
      endsAt,
    });

    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
    const body = res.body as {
      type: string;
      openGym: { classInProgress: { scheduledClassId: string; className: string } | null };
    };

    expect(body.type).toBe('OPEN_GYM');
    expect(body.openGym.classInProgress?.scheduledClassId).toBe(cls.id);

    // The decisive assertion: named for display, but not a participant by any measure.
    const classAttendance = await prisma.attendance.count({
      where: { scheduledClassId: cls.id },
    });
    const bookings = await prisma.booking.count({ where: { scheduledClassId: cls.id } });
    expect(classAttendance).toBe(0);
    expect(bookings).toBe(0);
  });

  // ── Unrestricted access (ARES Full Access) ────────────────────────────────────────────
  //
  // Full Access grants Open Gym with NO window, matching its "Sin restricciones de horario"
  // copy. These run at whatever the real clock says, which is the point: there is no hour at
  // which they may fail.

  const unrestricted: PlanShape = {
    name: 'Full Access',
    openGymAccess: true,
    openGymWindowStart: null,
    openGymWindowEnd: null,
  };

  it('admits an unrestricted plan at the current hour, whatever it is, and reports no window', async () => {
    const ctx = await setupScenario(unrestricted);

    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
    const body = res.body as {
      type: string;
      openGym: { membershipPlanName: string; windowStart: string | null; windowEnd: string | null };
    };

    expect(body.type).toBe('OPEN_GYM');
    expect(body.openGym.membershipPlanName).toBe('Full Access');
    // Null, not a fabricated 00:00–23:59: Front Desk renders "Sin restricción" from this.
    expect(body.openGym.windowStart).toBeNull();
    expect(body.openGym.windowEnd).toBeNull();
  });

  it('admits an unrestricted plan in a studio whose local time is the far side of the world', async () => {
    // Same instant, wildly different local clocks. An unrestricted plan must not care.
    for (const timezone of ['Pacific/Kiritimati', 'Pacific/Niue', 'Asia/Tokyo']) {
      const ctx = await setupScenario(unrestricted, { timezone });
      const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
      expect((res.body as { type: string }).type).toBe('OPEN_GYM');
    }
  });

  it('still refuses an unrestricted plan when the membership is not current', async () => {
    const ctx = await setupScenario(unrestricted, { subscriptionExpired: true });

    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(409);
    expect((res.body as { code: string }).code).toBe('WALLET_MEMBERSHIP_NOT_ENTITLED');
    expect(await prisma.attendance.count()).toBe(0);
  });

  it('still gives an applicable reservation priority over unrestricted Open Gym', async () => {
    const ctx = await setupScenario(unrestricted);
    const { startsAt, endsAt } = classStartingSoon();
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt,
      endsAt,
    });
    await createConfirmedBooking(prisma, ctx.studio.id, cls.id, ctx.member.id);

    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
    const body = res.body as { type: string; scheduledClassId: string };
    expect(body.type).toBe('CLASS');
    expect(body.scheduledClassId).toBe(cls.id);
  });

  it('still deduplicates a repeat scan on an unrestricted plan', async () => {
    const ctx = await setupScenario(unrestricted);

    const first = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
    const second = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);

    expect((second.body as { id: string }).id).toBe((first.body as { id: string }).id);
    expect(await prisma.attendance.count({ where: { studioId: ctx.studio.id } })).toBe(1);
  });

  it('creates no booking and no class attendance on an unrestricted plan', async () => {
    const ctx = await setupScenario(unrestricted);
    const { startsAt, endsAt } = classStartingSoon();
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt,
      endsAt,
    });

    await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);

    expect(await prisma.booking.count()).toBe(0);
    expect(await prisma.attendance.count({ where: { scheduledClassId: cls.id } })).toBe(0);
    expect(
      await prisma.attendance.count({
        where: { studioId: ctx.studio.id, type: CheckInType.OPEN_GYM },
      }),
    ).toBe(1);
  });

  // ── Case E/F/G: denials ───────────────────────────────────────────────────────────────

  it('denies with OUTSIDE_HOURS, and reports the plan window, when the local time is closed', async () => {
    const now = new Date();
    const timezone = 'America/Mexico_City';
    const shape: PlanShape = {
      name: 'Open Gym',
      openGymAccess: true,
      ...windowAfterNow(now, timezone),
    };
    const ctx = await setupScenario(shape, { timezone });

    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(409);
    const body = res.body as {
      code: string;
      membershipPlanName: string;
      windowStart: string;
      windowEnd: string;
    };
    expect(body.code).toBe('WALLET_OPEN_GYM_OUTSIDE_HOURS');
    expect(body.membershipPlanName).toBe('Open Gym');
    expect(body.windowStart).toBe(shape.openGymWindowStart);
    expect(body.windowEnd).toBe(shape.openGymWindowEnd);

    expect(await prisma.attendance.count()).toBe(0);
  });

  it('denies a plan without Open Gym as NOT_INCLUDED, never as a missing reservation', async () => {
    const ctx = await setupScenario({ name: 'Pro', openGymAccess: false });

    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(409);
    const body = res.body as { code: string; memberName: string };
    expect(body.code).toBe('WALLET_OPEN_GYM_NOT_INCLUDED');
    expect(body.memberName).toBeTruthy();
    expect(await prisma.attendance.count()).toBe(0);
  });

  it('denies a workshop-only plan (Booty Lab) as NOT_INCLUDED', async () => {
    const ctx = await setupScenario({ name: 'Booty Lab by Etzia', openGymAccess: false });
    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(409);
    expect((res.body as { code: string }).code).toBe('WALLET_OPEN_GYM_NOT_INCLUDED');
  });

  it('denies an expired membership as NOT_ENTITLED even when the plan grants Open Gym', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'), {
      subscriptionExpired: true,
    });

    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(409);
    expect((res.body as { code: string }).code).toBe('WALLET_MEMBERSHIP_NOT_ENTITLED');
    expect(await prisma.attendance.count()).toBe(0);
  });

  it('still offers walk-in candidates on a denial so staff keep the class escalation path', async () => {
    const ctx = await setupScenario({ name: 'Pro', openGymAccess: false });
    const { startsAt, endsAt } = classStartingSoon();
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt,
      endsAt,
    });

    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(409);
    const body = res.body as { walkInCandidates: { scheduledClassId: string }[] };
    expect(body.walkInCandidates.map((c) => c.scheduledClassId)).toEqual([cls.id]);
  });

  // ── Case A/B/C: class check-in still wins ─────────────────────────────────────────────

  it('checks the member into their CLASS when a reservation applies, not Open Gym', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    const { startsAt, endsAt } = classStartingSoon();
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt,
      endsAt,
    });
    await createConfirmedBooking(prisma, ctx.studio.id, cls.id, ctx.member.id);

    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
    const body = res.body as { type: string; scheduledClassId: string; openGym?: unknown };

    // Precedence: an eligible reservation always outranks facility access.
    expect(body.type).toBe('CLASS');
    expect(body.scheduledClassId).toBe(cls.id);
    expect(body.openGym).toBeUndefined();

    const rows = await prisma.attendance.findMany({ where: { studioId: ctx.studio.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe(CheckInType.CLASS);
  });

  it('leaves a future reservation untouched and admits the member to Open Gym instead', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    // Far outside the check-in window (opens 15 min before start).
    const startsAt = new Date(Date.now() + 6 * 60 * 60_000);
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
    });
    const booking = await createConfirmedBooking(prisma, ctx.studio.id, cls.id, ctx.member.id);

    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
    expect((res.body as { type: string }).type).toBe('OPEN_GYM');

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe(BookingStatus.CONFIRMED);
    expect(after.cancelledAt).toBeNull();
    expect(await prisma.attendance.count({ where: { scheduledClassId: cls.id } })).toBe(0);
  });

  it('does not create an Open Gym visit for a member already checked into their class', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    const { startsAt, endsAt } = classStartingSoon();
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt,
      endsAt,
    });
    await createConfirmedBooking(prisma, ctx.studio.id, cls.id, ctx.member.id);

    await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
    const second = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(409);

    expect((second.body as { code: string }).code).toBe('WALLET_ALREADY_CHECKED_IN');
    const rows = await prisma.attendance.findMany({ where: { studioId: ctx.studio.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe(CheckInType.CLASS);
  });

  // ── Data integrity: Open Gym must not leak into class state ───────────────────────────

  it('consumes zero class credits', async () => {
    const now = new Date();
    const ctx = await setupScenario({
      ...openGymPlanShape(now, 'America/Mexico_City'),
      classCredits: 1,
    });

    await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);

    const consumed = await membershipUsage.countConsumedClasses(
      prisma,
      ctx.studio.id,
      ctx.member.id,
      new Date(Date.now() - 30 * 86_400_000),
      new Date(Date.now() + 30 * 86_400_000),
    );
    expect(consumed).toBe(0);
  });

  it('does not appear in a class roster or its attendance list', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    const { startsAt, endsAt } = classStartingSoon();
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt,
      endsAt,
      capacity: 10,
    });

    await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);

    const roster = await request(app.getHttpServer())
      .get(`/api/v1/studios/${ctx.studio.id}/classes/${cls.id}/attendance`)
      .set('Authorization', `Bearer ${ctx.staffToken}`)
      .expect(200);
    expect(roster.body).toEqual([]);
  });

  it('does not change class capacity accounting', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    const { startsAt, endsAt } = classStartingSoon();
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt,
      endsAt,
      capacity: 10,
    });

    await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);

    const after = await prisma.scheduledClass.findUniqueOrThrow({
      where: { id: cls.id },
      include: { _count: { select: { bookings: true, attendances: true } } },
    });
    expect(after.capacity).toBe(10);
    expect(after._count.bookings).toBe(0);
    expect(after._count.attendances).toBe(0);
  });

  it('does not create or modify any booking', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
    expect(await prisma.booking.count()).toBe(0);
  });

  it('leaves an unrelated NO_SHOW booking untouched', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    const past = new Date(Date.now() - 3 * 60 * 60_000);
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt: past,
      endsAt: new Date(past.getTime() + 60 * 60_000),
    });
    const booking = await prisma.booking.create({
      data: {
        studioId: ctx.studio.id,
        scheduledClassId: cls.id,
        userId: ctx.member.id,
        status: BookingStatus.NO_SHOW,
      },
    });

    await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe(BookingStatus.NO_SHOW);
  });

  // ── Visit-based metrics must see Open Gym ─────────────────────────────────────────────

  it('counts toward the member last visit and visit totals', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));

    await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);

    const lastVisit = await prisma.attendance.findFirst({
      where: { studioId: ctx.studio.id, userId: ctx.member.id },
      orderBy: { checkedInAt: 'desc' },
    });
    expect(lastVisit).not.toBeNull();
    expect(lastVisit!.type).toBe(CheckInType.OPEN_GYM);

    const totalVisits = await prisma.attendance.count({
      where: { studioId: ctx.studio.id, userId: ctx.member.id },
    });
    expect(totalVisits).toBe(1);
  });

  it('appears in the member progress feed and check-in totals', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    const memberToken = await loginAccessToken(app, ctx.member.email, ctx.member.password);

    await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${ctx.studio.id}/members/me/progress`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const body = res.body as {
      totalCheckIns: number;
      monthCheckIns: number;
      currentStreak: number;
      classBreakdown: unknown[];
      favoriteClass: unknown;
      recentActivity: { className: string }[];
    };

    expect(body.totalCheckIns).toBe(1);
    expect(body.monthCheckIns).toBe(1);
    expect(body.currentStreak).toBe(1);
    expect(body.recentActivity[0]?.className).toBe('Open Gym');
    // A facility visit has no class to attribute, so it stays out of class-shaped analysis.
    expect(body.classBreakdown).toEqual([]);
    expect(body.favoriteClass).toBeNull();
  });

  // ── Repeat scans ──────────────────────────────────────────────────────────────────────

  it('treats a repeat scan inside the dedupe window as the same visit', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));

    const first = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
    const second = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);

    const firstBody = first.body as { id: string; openGym: { deduplicated: boolean } };
    const secondBody = second.body as { id: string; openGym: { deduplicated: boolean } };

    // Success both times — staff never see an error for scanning twice.
    expect(secondBody.id).toBe(firstBody.id);
    expect(firstBody.openGym.deduplicated).toBe(false);
    expect(secondBody.openGym.deduplicated).toBe(true);
    expect(await prisma.attendance.count({ where: { studioId: ctx.studio.id } })).toBe(1);
  });

  it('records a second real visit once the dedupe window has passed', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));

    // A morning visit, well outside the dedupe window — the member left and came back.
    await prisma.attendance.create({
      data: {
        studioId: ctx.studio.id,
        scheduledClassId: null,
        type: CheckInType.OPEN_GYM,
        userId: ctx.member.id,
        method: 'QR',
        checkedInAt: new Date(Date.now() - (DEDUPE_MINUTES + 2) * 60_000),
      },
    });

    const res = await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
    expect((res.body as { openGym: { deduplicated: boolean } }).openGym.deduplicated).toBe(false);
    expect(await prisma.attendance.count({ where: { studioId: ctx.studio.id } })).toBe(2);
  });

  it('scopes deduplication to one member, so a queue of scans all register', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    const other = await createUserWithPassword(prisma);
    await createMembership(prisma, other.id, ctx.studio.id, Role.MEMBER);
    await prisma.subscription.create({
      data: {
        studioId: ctx.studio.id,
        userId: other.id,
        membershipPlanId: ctx.plan.id,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: new Date(Date.now() - 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 25 * 86_400_000),
      },
    });
    const otherCredential = await walletCredentials.issue(ctx.studio.id, other.id);

    await scan(ctx.studio.id, ctx.staffToken, ctx.barcode).expect(201);
    await scan(
      ctx.studio.id,
      ctx.staffToken,
      buildWalletCredentialBarcode(otherCredential.rawCredential!),
    ).expect(201);

    expect(await prisma.attendance.count({ where: { studioId: ctx.studio.id } })).toBe(2);
  });

  // ── Timezone ──────────────────────────────────────────────────────────────────────────

  it('evaluates the window in the studio timezone, not the server timezone', async () => {
    const now = new Date();
    // Built around Mexico City local time; Tokyo is 15 hours ahead, so the same instant can
    // never fall inside this two-hour window there.
    const mexicoWindow = windowContainingNow(now, 'America/Mexico_City');

    const allowed = await setupScenario(
      { name: 'Basic Access', openGymAccess: true, ...mexicoWindow },
      { timezone: 'America/Mexico_City' },
    );
    await scan(allowed.studio.id, allowed.staffToken, allowed.barcode).expect(201);

    const denied = await setupScenario(
      { name: 'Basic Access', openGymAccess: true, ...mexicoWindow },
      { timezone: 'Asia/Tokyo' },
    );
    const res = await scan(denied.studio.id, denied.staffToken, denied.barcode).expect(409);
    expect((res.body as { code: string }).code).toBe('WALLET_OPEN_GYM_OUTSIDE_HOURS');
  });

  // ── Non-regression ────────────────────────────────────────────────────────────────────

  it('leaves manual booking check-in behaviour unchanged, including duplicate rejection', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    const { startsAt, endsAt } = classStartingSoon();
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt,
      endsAt,
    });
    const booking = await createConfirmedBooking(prisma, ctx.studio.id, cls.id, ctx.member.id);

    const first = await request(app.getHttpServer())
      .post(`/api/v1/studios/${ctx.studio.id}/check-ins/manual`)
      .set('Authorization', `Bearer ${ctx.staffToken}`)
      .send({ bookingId: booking.id })
      .expect(201);
    expect((first.body as { type: string }).type).toBe('CLASS');

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${ctx.studio.id}/check-ins/manual`)
      .set('Authorization', `Bearer ${ctx.staffToken}`)
      .send({ bookingId: booking.id })
      .expect(409);

    expect(await prisma.attendance.count({ where: { scheduledClassId: cls.id } })).toBe(1);
  });

  it('still refuses a class check-in outside the class check-in window', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    const startsAt = new Date(Date.now() + 6 * 60 * 60_000);
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
    });
    const booking = await createConfirmedBooking(prisma, ctx.studio.id, cls.id, ctx.member.id);

    // Unchanged pre-existing semantics: the window is not yet open, which is a 400, not the
    // 409 used for an already-consumed check-in.
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${ctx.studio.id}/check-ins/manual`)
      .set('Authorization', `Bearer ${ctx.staffToken}`)
      .send({ bookingId: booking.id })
      .expect(400);
  });

  it('records the walk-in class path as CLASS attendance, never as Open Gym', async () => {
    const now = new Date();
    const ctx = await setupScenario(openGymPlanShape(now, 'America/Mexico_City'));
    const { startsAt, endsAt } = classStartingSoon();
    const cls = await createScheduledClass(prisma, ctx.studio.id, ctx.template.id, {
      startsAt,
      endsAt,
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${ctx.studio.id}/classes/${cls.id}/manual-attendance`)
      .set('Authorization', `Bearer ${ctx.staffToken}`)
      .send({ memberId: ctx.member.id })
      .expect(201);

    expect((res.body as { type: string }).type).toBe('CLASS');
    const row = await prisma.attendance.findFirstOrThrow({ where: { scheduledClassId: cls.id } });
    expect(row.type).toBe(CheckInType.CLASS);
  });
});
