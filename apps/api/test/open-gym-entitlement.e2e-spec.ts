import type { INestApplication } from '@nestjs/common';
import {
  BillingInterval,
  BookingStatus,
  CheckInMethod,
  CheckInType,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildWalletCredentialBarcode } from '../src/wallet/wallet-credential.constants';
import { WalletCredentialService } from '../src/wallet/wallet-credential.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createClassTemplate,
  createMembership,
  createScheduledClass,
  createStudio,
  createUserWithPassword,
} from './helpers/factories';

/**
 * Open Gym entitlement is decided by ONE persisted field: MembershipPlan.openGymAccess (the
 * Admin toggle). These tests pin that every way into Open Gym — door scan, booking a scheduled
 * Open Gym slot, waitlist, staff booking, walk-in attendance and check-in of an existing
 * reservation — obeys that field, that the toggle round-trips through the Admin API and takes
 * effect on the very next request, and that nothing about ordinary classes changes.
 *
 * The leak this suite exists for: Open Gym slots used to be authorized by class access alone,
 * so a plan with "Todas las clases" (or the slot ticked in its class list) got Open Gym even
 * with openGymAccess=false, and a confirmed reservation kept admitting after the plan lost it.
 *
 * Plans are named after the ARES catalogue for readability only. Nothing in the code under
 * test looks at a plan name — the "Basic enabled in an isolated studio" case proves it.
 */

const TZ = 'America/Mexico_City';
const MIN = 60_000;
const DAY = 86_400_000;

type Api = ReturnType<typeof request>;

describe('Open Gym entitlement (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let walletCredentials: WalletCredentialService;
  let http: () => Api;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    walletCredentials = app.get(WalletCredentialService);
    http = () => request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  async function login(email: string, password: string): Promise<string> {
    const res = await http().post('/api/v1/auth/login').send({ email, password }).expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  type PlanSpec = {
    name: string;
    openGymAccess: boolean;
    allClassesAccess?: boolean;
    /** Explicit class list. The Open Gym slot may be listed and must STILL be refused when the toggle is off. */
    templateIds?: string[];
    classCredits?: number | null;
    window?: { start: string; end: string } | null;
    exclusiveGroup?: string | null;
  };

  async function createPlan(studioId: string, spec: PlanSpec) {
    const plan = await prisma.membershipPlan.create({
      data: {
        studioId,
        name: spec.name,
        priceCents: 100000,
        currency: 'mxn',
        billingInterval: BillingInterval.MONTHLY,
        active: true,
        classCredits: spec.classCredits ?? null,
        allClassesAccess: spec.allClassesAccess ?? false,
        openGymAccess: spec.openGymAccess,
        openGymWindowStart: spec.window?.start ?? null,
        openGymWindowEnd: spec.window?.end ?? null,
        exclusiveGroup: spec.exclusiveGroup === undefined ? 'CORE' : spec.exclusiveGroup,
      },
    });
    if (!spec.allClassesAccess && spec.templateIds?.length) {
      await prisma.membershipPlanClassAccess.createMany({
        data: spec.templateIds.map((classTemplateId) => ({
          studioId,
          membershipPlanId: plan.id,
          classTemplateId,
        })),
      });
    }
    return plan;
  }

  /** One studio laid out like ARES: Full Access with Open Gym, Basic/Pro without. */
  async function setupStudio() {
    const studio = await createStudio(prisma, { timezone: TZ, allowWaitlist: true });
    const openGymTemplate = await prisma.classTemplate.create({
      data: {
        studioId: studio.id,
        name: 'Open Gym',
        durationMinutes: 60,
        defaultCapacity: 20,
        isOpenGymSlot: true,
        equipment: [],
        tags: [],
      },
    });
    const strength = await createClassTemplate(prisma, studio.id, { name: 'Strength' });

    const full = await createPlan(studio.id, {
      name: 'Full Access',
      openGymAccess: true,
      templateIds: [strength.id, openGymTemplate.id],
    });
    // Basic lists the Open Gym slot in its class list on purpose: the class list must not grant it.
    const basic = await createPlan(studio.id, {
      name: 'Basic Access',
      openGymAccess: false,
      templateIds: [strength.id, openGymTemplate.id],
      classCredits: 12,
    });
    // Pro is "Todas las clases": allClassesAccess must not imply Open Gym.
    const pro = await createPlan(studio.id, {
      name: 'Pro',
      openGymAccess: false,
      allClassesAccess: true,
      classCredits: 6,
    });

    const owner = await createUserWithPassword(prisma);
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const desk = await createUserWithPassword(prisma);
    await createMembership(prisma, desk.id, studio.id, Role.FRONT_DESK);

    return {
      studio,
      openGymTemplate,
      strength,
      plans: { full, basic, pro },
      ownerToken: await login(owner.email, owner.password),
      deskToken: await login(desk.email, desk.password),
    };
  }

  type SubSpec = {
    status?: SubscriptionStatus;
    periodEndOffsetMs?: number;
    entitlementEndsAt?: Date | null;
  };

  async function createMember(studioId: string, planIds: Array<string | { planId: string } & SubSpec>) {
    const user = await createUserWithPassword(prisma);
    await createMembership(prisma, user.id, studioId, Role.MEMBER);
    const now = Date.now();
    for (const entry of planIds) {
      const spec: { planId: string } & SubSpec = typeof entry === 'string' ? { planId: entry } : entry;
      await prisma.subscription.create({
        data: {
          studioId,
          userId: user.id,
          membershipPlanId: spec.planId,
          status: spec.status ?? SubscriptionStatus.ACTIVE,
          currentPeriodStart: new Date(now - 5 * DAY),
          currentPeriodEnd: new Date(now + (spec.periodEndOffsetMs ?? 25 * DAY)),
          entitlementEndsAt: spec.entitlementEndsAt ?? null,
        },
      });
    }
    const { rawCredential } = await walletCredentials.issue(studioId, user.id);
    return {
      user,
      token: await login(user.email, user.password),
      barcode: buildWalletCredentialBarcode(rawCredential!),
    };
  }

  /** A class whose check-in window is open now and which has not started (bookable). */
  async function classSoon(studioId: string, templateId: string, minutesFromNow = 10, capacity = 10) {
    const startsAt = new Date(Date.now() + minutesFromNow * MIN);
    return createScheduledClass(prisma, studioId, templateId, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * MIN),
      capacity,
    });
  }

  const book = (studioId: string, token: string, classId: string) =>
    http()
      .post(`/api/v1/studios/${studioId}/classes/${classId}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
  const joinWaitlist = (studioId: string, token: string, classId: string) =>
    http()
      .post(`/api/v1/studios/${studioId}/classes/${classId}/waitlist`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
  const scan = (studioId: string, deskToken: string, barcode: string) =>
    http()
      .post(`/api/v1/studios/${studioId}/check-ins/qr`)
      .set('Authorization', `Bearer ${deskToken}`)
      .send({ qrToken: barcode });
  const manualCheckIn = (studioId: string, deskToken: string, bookingId: string) =>
    http()
      .post(`/api/v1/studios/${studioId}/check-ins/manual`)
      .set('Authorization', `Bearer ${deskToken}`)
      .send({ bookingId });
  const walkIn = (studioId: string, deskToken: string, classId: string, memberId: string) =>
    http()
      .post(`/api/v1/studios/${studioId}/classes/${classId}/manual-attendance`)
      .set('Authorization', `Bearer ${deskToken}`)
      .send({ memberId });
  const staffBook = (studioId: string, token: string, userId: string, scheduledClassId: string, extra = {}) =>
    http()
      .post(`/api/v1/studios/${studioId}/members/${userId}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .send({ scheduledClassId, ...extra });
  const myProfile = async (studioId: string, token: string) =>
    (
      await http()
        .get(`/api/v1/studios/${studioId}/members/me`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body as { openGym: { included: boolean; membershipPlanName: string | null; windowStart: string | null } };
  const patchPlan = (studioId: string, ownerToken: string, planId: string, body: object) =>
    http()
      .patch(`/api/v1/studios/${studioId}/membership-plans/${planId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body);

  // ── Full Access enabled ─────────────────────────────────────────────────────────────────

  it('Full Access (enabled): Open Gym visible, slot bookable, booking checks in, door admits', async () => {
    const ctx = await setupStudio();
    const member = await createMember(ctx.studio.id, [ctx.plans.full.id]);

    const profile = await myProfile(ctx.studio.id, member.token);
    expect(profile.openGym).toEqual({
      included: true,
      membershipPlanName: 'Full Access',
      windowStart: null,
      windowEnd: null,
    });

    const slot = await classSoon(ctx.studio.id, ctx.openGymTemplate.id);
    const schedule = await http()
      .get(`/api/v1/studios/${ctx.studio.id}/schedule`)
      .query({ from: new Date(Date.now() - DAY).toISOString(), to: new Date(Date.now() + DAY).toISOString() })
      .set('Authorization', `Bearer ${member.token}`)
      .expect(200);
    const listed = (schedule.body as Array<{ id: string; classTemplate: { isOpenGymSlot: boolean } }>).find(
      (c) => c.id === slot.id,
    );
    expect(listed?.classTemplate.isOpenGymSlot).toBe(true);

    const booking = await book(ctx.studio.id, member.token, slot.id).expect(201);
    const checkIn = await manualCheckIn(ctx.studio.id, ctx.deskToken, (booking.body as { id: string }).id).expect(201);
    expect((checkIn.body as { type: string }).type).toBe(CheckInType.CLASS);

    const doorMember = await createMember(ctx.studio.id, [ctx.plans.full.id]);
    const door = await scan(ctx.studio.id, ctx.deskToken, doorMember.barcode).expect(201);
    expect((door.body as { type: string }).type).toBe(CheckInType.OPEN_GYM);
  });

  // ── Basic and Pro disabled ──────────────────────────────────────────────────────────────

  it.each([
    ['Basic Access (slot ticked in class list)', 'basic'],
    ['Pro ("Todas las clases")', 'pro'],
  ] as const)('%s disabled: invisible, every Open Gym path denied', async (_label, planKey) => {
    const ctx = await setupStudio();
    const member = await createMember(ctx.studio.id, [ctx.plans[planKey].id]);

    expect((await myProfile(ctx.studio.id, member.token)).openGym.included).toBe(false);

    // Direct API booking, bypassing any UI.
    const slot = await classSoon(ctx.studio.id, ctx.openGymTemplate.id);
    const denied = await book(ctx.studio.id, member.token, slot.id).expect(403);
    expect((denied.body as { message: string }).message).toBe('Tu membresía no incluye esta clase.');

    // Waitlist on a full slot goes through the same gate.
    const fullSlot = await classSoon(ctx.studio.id, ctx.openGymTemplate.id, 12, 1);
    const fullAccessMember = await createMember(ctx.studio.id, [ctx.plans.full.id]);
    await book(ctx.studio.id, fullAccessMember.token, fullSlot.id).expect(201);
    await joinWaitlist(ctx.studio.id, member.token, fullSlot.id).expect(403);

    // Door (no reservation).
    const door = await scan(ctx.studio.id, ctx.deskToken, member.barcode).expect(409);
    expect((door.body as { code: string }).code).toBe('WALLET_OPEN_GYM_NOT_INCLUDED');

    // Front Desk walk-in into a running Open Gym slot.
    await walkIn(ctx.studio.id, ctx.deskToken, slot.id, member.user.id).expect(403);

    // Staff booking on the member's behalf.
    await staffBook(ctx.studio.id, ctx.ownerToken, member.user.id, slot.id).expect(403);

    expect(await prisma.booking.count({ where: { userId: member.user.id } })).toBe(0);
    expect(await prisma.attendance.count({ where: { userId: member.user.id } })).toBe(0);
  });

  it('Basic and Pro keep booking and checking into ordinary classes', async () => {
    const ctx = await setupStudio();
    for (const planId of [ctx.plans.basic.id, ctx.plans.pro.id]) {
      const member = await createMember(ctx.studio.id, [planId]);
      const cls = await classSoon(ctx.studio.id, ctx.strength.id);
      const booking = await book(ctx.studio.id, member.token, cls.id).expect(201);
      // Wallet scan with an in-window ordinary booking still checks into the class.
      const res = await scan(ctx.studio.id, ctx.deskToken, member.barcode).expect(201);
      expect((res.body as { type: string; scheduledClassId: string }).type).toBe(CheckInType.CLASS);
      expect((res.body as { scheduledClassId: string }).scheduledClassId).toBe(cls.id);
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: (booking.body as { id: string }).id } });
      // Credit-metered plans still attribute the booking to the membership.
      expect(row.subscriptionId).not.toBeNull();
    }
  });

  it('walk-in candidates offered after an Open Gym denial never include an Open Gym slot', async () => {
    const ctx = await setupStudio();
    const member = await createMember(ctx.studio.id, [ctx.plans.basic.id]);
    const slot = await classSoon(ctx.studio.id, ctx.openGymTemplate.id, 5);
    const cls = await classSoon(ctx.studio.id, ctx.strength.id, 8);

    const res = await scan(ctx.studio.id, ctx.deskToken, member.barcode).expect(409);
    const ids = (res.body as { walkInCandidates: Array<{ scheduledClassId: string }> }).walkInCandidates.map(
      (c) => c.scheduledClassId,
    );
    expect(ids).toContain(cls.id);
    expect(ids).not.toContain(slot.id);
  });

  // ── The Admin toggle is the authority ───────────────────────────────────────────────────

  it('turning Full Access off in Admin denies it immediately; existing reservation preserved but no longer admits', async () => {
    const ctx = await setupStudio();
    const member = await createMember(ctx.studio.id, [ctx.plans.full.id]);
    const slot = await classSoon(ctx.studio.id, ctx.openGymTemplate.id);
    const booking = (await book(ctx.studio.id, member.token, slot.id).expect(201)).body as { id: string };

    // Persist through the real Admin endpoint and read the saved value back.
    const patched = await patchPlan(ctx.studio.id, ctx.ownerToken, ctx.plans.full.id, { openGymAccess: false }).expect(200);
    expect((patched.body as { openGymAccess: boolean }).openGymAccess).toBe(false);
    const listed = await http()
      .get(`/api/v1/studios/${ctx.studio.id}/membership-plans`)
      .set('Authorization', `Bearer ${ctx.ownerToken}`)
      .expect(200);
    expect(
      (listed.body as Array<{ id: string; openGymAccess: boolean }>).find((p) => p.id === ctx.plans.full.id)
        ?.openGymAccess,
    ).toBe(false);
    const audit = await prisma.auditLog.findFirst({
      where: { studioId: ctx.studio.id, action: 'MEMBERSHIP_PLAN_UPDATED', entityId: ctx.plans.full.id },
    });
    expect(JSON.stringify(audit?.metadata)).toContain('openGymAccess');

    // Next request, no cache: visibility, booking, staff check-in and wallet scan all refuse.
    expect((await myProfile(ctx.studio.id, member.token)).openGym.included).toBe(false);
    const another = await classSoon(ctx.studio.id, ctx.openGymTemplate.id, 200);
    await book(ctx.studio.id, member.token, another.id).expect(403);

    const staffDenied = await manualCheckIn(ctx.studio.id, ctx.deskToken, booking.id).expect(409);
    expect((staffDenied.body as { code: string; memberId: string }).code).toBe('WALLET_OPEN_GYM_NOT_INCLUDED');
    expect((staffDenied.body as { memberId: string }).memberId).toBe(member.user.id);
    const walletDenied = await scan(ctx.studio.id, ctx.deskToken, member.barcode).expect(409);
    expect((walletDenied.body as { code: string }).code).toBe('WALLET_OPEN_GYM_NOT_INCLUDED');

    // The reservation is preserved — never silently cancelled — and nothing was recorded.
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(row.status).toBe(BookingStatus.CONFIRMED);
    expect(await prisma.attendance.count({ where: { userId: member.user.id } })).toBe(0);

    // Turning it back on restores access to the same reservation.
    await patchPlan(ctx.studio.id, ctx.ownerToken, ctx.plans.full.id, { openGymAccess: true }).expect(200);
    await manualCheckIn(ctx.studio.id, ctx.deskToken, booking.id).expect(201);
  });

  it('enabling Basic in an isolated studio grants access there — and only there (configurable, tenant-scoped)', async () => {
    const a = await setupStudio();
    const b = await setupStudio();
    const memberA = await createMember(a.studio.id, [a.plans.basic.id]);
    const memberB = await createMember(b.studio.id, [b.plans.basic.id]);

    const res = await patchPlan(a.studio.id, a.ownerToken, a.plans.basic.id, {
      openGymAccess: true,
    }).expect(200);
    expect((res.body as { openGymAccess: boolean }).openGymAccess).toBe(true);

    // Studio A's Basic now has Open Gym through every path.
    expect((await myProfile(a.studio.id, memberA.token)).openGym).toMatchObject({
      included: true,
      membershipPlanName: 'Basic Access',
    });
    const slotA = await classSoon(a.studio.id, a.openGymTemplate.id);
    await book(a.studio.id, memberA.token, slotA.id).expect(201);
    const doorMemberA = await createMember(a.studio.id, [a.plans.basic.id]);
    await scan(a.studio.id, a.deskToken, doorMemberA.barcode).expect(201);

    // Studio B is untouched: same plan name, its own saved toggle, still denied.
    expect((await myProfile(b.studio.id, memberB.token)).openGym.included).toBe(false);
    const slotB = await classSoon(b.studio.id, b.openGymTemplate.id);
    await book(b.studio.id, memberB.token, slotB.id).expect(403);
    await scan(b.studio.id, b.deskToken, memberB.barcode).expect(409);

    // Cross-tenant: studio A's owner cannot flip studio B's plan.
    await patchPlan(b.studio.id, a.ownerToken, b.plans.basic.id, { openGymAccess: true }).expect(403);
    const bPlan = await prisma.membershipPlan.findUniqueOrThrow({ where: { id: b.plans.basic.id } });
    expect(bPlan.openGymAccess).toBe(false);
  });

  it('Admin toggle validation: disabling clears hours, half windows are rejected, Open-Gym-only plans are valid', async () => {
    const ctx = await setupStudio();

    const withWindow = await patchPlan(ctx.studio.id, ctx.ownerToken, ctx.plans.basic.id, {
      openGymAccess: true,
      openGymWindowStart: '11:00',
      openGymWindowEnd: '17:00',
    }).expect(200);
    expect(withWindow.body).toMatchObject({ openGymAccess: true, openGymWindowStart: '11:00', openGymWindowEnd: '17:00' });

    await patchPlan(ctx.studio.id, ctx.ownerToken, ctx.plans.basic.id, {
      openGymWindowStart: '11:00',
      openGymWindowEnd: null,
    }).expect(400);
    await patchPlan(ctx.studio.id, ctx.ownerToken, ctx.plans.basic.id, { openGymWindowStart: '9:00' }).expect(400);

    const off = await patchPlan(ctx.studio.id, ctx.ownerToken, ctx.plans.basic.id, { openGymAccess: false }).expect(200);
    expect(off.body).toMatchObject({ openGymAccess: false, openGymWindowStart: null, openGymWindowEnd: null });

    const created = await http()
      .post(`/api/v1/studios/${ctx.studio.id}/membership-plans`)
      .set('Authorization', `Bearer ${ctx.ownerToken}`)
      .send({
        name: 'Solo Open Gym',
        priceCents: 50000,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
        allClassesAccess: false,
        classTemplateIds: [],
        openGymAccess: true,
      })
      .expect(201);
    expect((created.body as { openGymAccess: boolean }).openGymAccess).toBe(true);

    const deniedByDefault = await http()
      .post(`/api/v1/studios/${ctx.studio.id}/membership-plans`)
      .set('Authorization', `Bearer ${ctx.ownerToken}`)
      .send({ name: 'Default', priceCents: 50000, currency: 'mxn', billingInterval: 'MONTHLY' })
      .expect(201);
    expect((deniedByDefault.body as { openGymAccess: boolean }).openGymAccess).toBe(false);
  });

  // ── Membership validity ─────────────────────────────────────────────────────────────────

  it.each([
    ['expired period', { periodEndOffsetMs: -DAY }],
    ['canceled', { status: SubscriptionStatus.CANCELED }],
    ['paused', { status: SubscriptionStatus.PAUSED }],
    ['past due', { status: SubscriptionStatus.PAST_DUE }],
  ] as const)('Full Access %s: denied everywhere', async (_label, spec) => {
    const ctx = await setupStudio();
    const member = await createMember(ctx.studio.id, [{ planId: ctx.plans.full.id, ...spec }]);

    expect((await myProfile(ctx.studio.id, member.token)).openGym.included).toBe(false);
    const slot = await classSoon(ctx.studio.id, ctx.openGymTemplate.id);
    await book(ctx.studio.id, member.token, slot.id).expect(403);
    const door = await scan(ctx.studio.id, ctx.deskToken, member.barcode).expect(409);
    expect((door.body as { code: string }).code).toBe('WALLET_MEMBERSHIP_NOT_ENTITLED');
  });

  it('a reservation made while entitled stops admitting once the membership is no longer entitled', async () => {
    const ctx = await setupStudio();
    const member = await createMember(ctx.studio.id, [ctx.plans.full.id]);
    const slot = await classSoon(ctx.studio.id, ctx.openGymTemplate.id);
    const booking = (await book(ctx.studio.id, member.token, slot.id).expect(201)).body as { id: string };

    await prisma.subscription.updateMany({
      where: { userId: member.user.id },
      data: { status: SubscriptionStatus.PAUSED },
    });

    const res = await manualCheckIn(ctx.studio.id, ctx.deskToken, booking.id).expect(409);
    expect((res.body as { code: string }).code).toBe('WALLET_MEMBERSHIP_NOT_ENTITLED');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      BookingStatus.CONFIRMED,
    );
  });

  // ── Multiple memberships ────────────────────────────────────────────────────────────────

  it('multiple memberships: entitled by any VALID membership whose plan grants Open Gym — never by an expired one', async () => {
    const ctx = await setupStudio();
    const stackable = await createPlan(ctx.studio.id, {
      name: 'Booty Lab',
      openGymAccess: false,
      templateIds: [ctx.strength.id],
      classCredits: 4,
      exclusiveGroup: null,
    });

    // Booty Lab (no Open Gym) + Full Access (Open Gym) → entitled through Full Access.
    const stacked = await createMember(ctx.studio.id, [stackable.id, ctx.plans.full.id]);
    expect((await myProfile(ctx.studio.id, stacked.token)).openGym).toMatchObject({
      included: true,
      membershipPlanName: 'Full Access',
    });
    const slot = await classSoon(ctx.studio.id, ctx.openGymTemplate.id);
    const booked = await book(ctx.studio.id, stacked.token, slot.id).expect(201);
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: (booked.body as { id: string }).id } });
    const fullSub = await prisma.subscription.findFirstOrThrow({
      where: { userId: stacked.user.id, membershipPlanId: ctx.plans.full.id },
    });
    expect(row.subscriptionId).toBe(fullSub.id);

    // Expired Full Access + active Basic → the expired one grants nothing.
    const lapsed = await createMember(ctx.studio.id, [
      { planId: ctx.plans.full.id, periodEndOffsetMs: -DAY },
      ctx.plans.basic.id,
    ]);
    expect((await myProfile(ctx.studio.id, lapsed.token)).openGym.included).toBe(false);
    const door = await scan(ctx.studio.id, ctx.deskToken, lapsed.barcode).expect(409);
    expect((door.body as { code: string }).code).toBe('WALLET_OPEN_GYM_NOT_INCLUDED');
  });

  // ── Staff paths and preserved history ───────────────────────────────────────────────────

  it('staff booking: honors the toggle; the audited OWNER override remains an explicit exception', async () => {
    const ctx = await setupStudio();
    const basicMember = await createMember(ctx.studio.id, [ctx.plans.basic.id]);
    const fullMember = await createMember(ctx.studio.id, [ctx.plans.full.id]);
    const slot = await classSoon(ctx.studio.id, ctx.openGymTemplate.id);

    await staffBook(ctx.studio.id, ctx.ownerToken, fullMember.user.id, slot.id).expect(201);
    await staffBook(ctx.studio.id, ctx.ownerToken, basicMember.user.id, slot.id).expect(403);
    await staffBook(ctx.studio.id, ctx.ownerToken, basicMember.user.id, slot.id, {
      overrideEntitlement: true,
      overrideReason: 'Cortesía aprobada por dirección',
    }).expect(201);
    const audit = await prisma.auditLog.findFirst({
      where: { studioId: ctx.studio.id, action: 'ENTITLEMENT_OVERRIDE_STAFF_BOOKING', targetUserId: basicMember.user.id },
    });
    expect(audit).not.toBeNull();
  });

  it('historical Open Gym attendance is never touched by a toggle change', async () => {
    const ctx = await setupStudio();
    const member = await createMember(ctx.studio.id, [ctx.plans.full.id]);
    const past = await prisma.attendance.create({
      data: {
        studioId: ctx.studio.id,
        userId: member.user.id,
        type: CheckInType.OPEN_GYM,
        scheduledClassId: null,
        method: CheckInMethod.QR,
        checkedInAt: new Date(Date.now() - 3 * DAY),
      },
    });

    await patchPlan(ctx.studio.id, ctx.ownerToken, ctx.plans.full.id, { openGymAccess: false }).expect(200);

    const after = await prisma.attendance.findUniqueOrThrow({ where: { id: past.id } });
    expect(after).toEqual(past);
  });
});
