import type { INestApplication } from '@nestjs/common';
import { BookingStatus, ClassStatus, Prisma, Role, SubscriptionEndReason, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeWebhookService } from '../src/billing/stripe-webhook.service';
import { CORE_EXCLUSIVE_GROUP } from '../src/memberships/membership-compatibility';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';

/**
 * MM-1..MM-3 — multi-membership invariant, entitlement aggregation, attribution, and
 * isolation, exercised over real HTTP against the real services with the capability gate ON.
 *
 * TEST-DATABASE-ONLY index swap: this suite previews the FUTURE gated constraint rollout by
 * replacing the two member-scoped partial unique indexes with the plan/group-scoped ones in
 * the dedicated test database (beforeAll), and restores the production-shaped originals in
 * afterAll. No migration file for the swap exists yet — that remains a separate, explicitly
 * gated release. Production is never touched by this suite.
 */

type WebhookSubPayload = {
  id: string;
  status: string;
  customer: string;
  cancel_at_period_end: boolean;
  metadata: Record<string, string>;
  items: { data: Array<{ price: { id: string }; current_period_start: number; current_period_end: number }> };
};

type WebhookServiceUnderTest = {
  upsertSubscriptionFromStripe: (
    sub: WebhookSubPayload,
    md: { userId?: string; studioId?: string; planId?: string },
    stripeEventType: string,
  ) => Promise<void>;
};

async function loginAccessToken(app: INestApplication, email: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

describe('Multi-membership MM-1..MM-3 (e2e, gate ON, future indexes previewed in test DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let webhookService: WebhookServiceUnderTest;

  beforeAll(async () => {
    process.env['MULTI_MEMBERSHIP_ENABLED'] = 'true';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    webhookService = app.get(StripeWebhookService) as unknown as WebhookServiceUnderTest;

    // Preview of the future gated constraint swap — TEST DB ONLY.
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "subscriptions_one_active_per_user_per_studio_idx"`);
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "subscriptions_one_scheduled_per_user_per_studio_idx"`);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX "mm_test_one_renewable_per_member_plan_idx"
      ON "subscriptions" ("studio_id", "user_id", "membership_plan_id")
      WHERE "status" IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED')
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX "mm_test_one_renewable_per_member_group_idx"
      ON "subscriptions" ("studio_id", "user_id", "exclusive_group_key")
      WHERE "status" IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED') AND "exclusive_group_key" IS NOT NULL
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX "mm_test_one_scheduled_per_member_plan_idx"
      ON "subscriptions" ("studio_id", "user_id", "membership_plan_id")
      WHERE "status" = 'SCHEDULED'
    `);
  });

  afterAll(async () => {
    // Restore the production-shaped indexes so every other e2e suite sees today's invariant.
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "mm_test_one_renewable_per_member_plan_idx"`);
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "mm_test_one_renewable_per_member_group_idx"`);
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "mm_test_one_scheduled_per_member_plan_idx"`);
    await truncateAll(prisma);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX "subscriptions_one_active_per_user_per_studio_idx"
      ON "subscriptions" ("studio_id", "user_id")
      WHERE "status" = 'ACTIVE'::"SubscriptionStatus"
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX "subscriptions_one_scheduled_per_user_per_studio_idx"
      ON "subscriptions" ("studio_id", "user_id")
      WHERE "status" = 'SCHEDULED'::"SubscriptionStatus"
    `);
    delete process.env['MULTI_MEMBERSHIP_ENABLED'];
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  // ── Fixtures mirroring the approved ARES product model ────────────────────

  async function setupStudioWithPlans() {
    const studio = await createStudio(prisma);
    const generalTemplate = await prisma.classTemplate.create({
      data: { studioId: studio.id, name: 'Strength', durationMinutes: 60, defaultCapacity: 12, equipment: [], tags: [] },
    });
    const bootyTemplate = await prisma.classTemplate.create({
      data: { studioId: studio.id, name: 'Booty Lab', durationMinutes: 60, defaultCapacity: 12, equipment: [], tags: [] },
    });

    const fullPlan = await prisma.membershipPlan.create({
      data: {
        studioId: studio.id, name: 'Full Access', priceCents: 150000, currency: 'mxn',
        billingInterval: 'MONTHLY', active: true, allClassesAccess: false,
        exclusiveGroup: CORE_EXCLUSIVE_GROUP,
        classTemplateAccess: { create: [{ studioId: studio.id, classTemplateId: generalTemplate.id }] },
      },
    });
    const basicPlan = await prisma.membershipPlan.create({
      data: {
        studioId: studio.id, name: 'Basic Access', priceCents: 100000, currency: 'mxn',
        billingInterval: 'MONTHLY', active: true, allClassesAccess: false, classCredits: 12,
        exclusiveGroup: CORE_EXCLUSIVE_GROUP,
        classTemplateAccess: { create: [{ studioId: studio.id, classTemplateId: generalTemplate.id }] },
      },
    });
    const bootyPlan = await prisma.membershipPlan.create({
      data: {
        studioId: studio.id, name: 'Booty Lab by Etzia', priceCents: 80000, currency: 'mxn',
        billingInterval: 'MONTHLY', active: true, allClassesAccess: false,
        classCredits: 4, entitlementDays: 45,
        exclusiveGroup: null,
        classTemplateAccess: { create: [{ studioId: studio.id, classTemplateId: bootyTemplate.id }] },
      },
    });
    return { studio, generalTemplate, bootyTemplate, fullPlan, basicPlan, bootyPlan };
  }

  async function setupMemberAndAdmin(studioId: string, prefix: string) {
    const member = await createUserWithPassword(prisma, { email: `${prefix}-mem@e2e.local` });
    const admin = await createUserWithPassword(prisma, { email: `${prefix}-adm@e2e.local` });
    await createMembership(prisma, member.id, studioId, Role.MEMBER);
    await createMembership(prisma, admin.id, studioId, Role.OWNER);
    const memberToken = await loginAccessToken(app, member.email, member.password);
    const adminToken = await loginAccessToken(app, admin.email, admin.password);
    return { member, admin, memberToken, adminToken };
  }

  function cashSale(studioId: string, adminToken: string, memberId: string, planId: string, amountCents: number) {
    return request(app.getHttpServer())
      .post(`/api/v1/studios/${studioId}/members/${memberId}/offline-subscriptions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ planId, amountCents, paymentMethod: 'CASH' });
  }

  async function activeSubs(studioId: string, userId: string) {
    return prisma.subscription.findMany({
      where: { studioId, userId, status: SubscriptionStatus.ACTIVE },
      orderBy: { createdAt: 'asc' },
      include: { membershipPlan: { select: { name: true } } },
    });
  }

  function stripePayload(id: string, studioId: string, userId: string, planId: string): WebhookSubPayload {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      id,
      status: 'active',
      customer: 'cus_e2e',
      cancel_at_period_end: false,
      metadata: { userId, studioId, planId },
      items: { data: [{ price: { id: `price_${id}` }, current_period_start: nowSec, current_period_end: nowSec + 30 * 86_400 }] },
    };
  }

  // ── Purchase compatibility matrix (cash + cash) ────────────────────────────

  it('CORE + Booty Lab: cash Booty sale leaves the ACTIVE CORE membership untouched — both ACTIVE', async () => {
    const { studio, fullPlan, bootyPlan } = await setupStudioWithPlans();
    const { member, adminToken } = await setupMemberAndAdmin(studio.id, 'core-booty');

    await cashSale(studio.id, adminToken, member.id, fullPlan.id, 150000).expect(201);
    const fullBefore = (await activeSubs(studio.id, member.id))[0]!;

    await cashSale(studio.id, adminToken, member.id, bootyPlan.id, 80000).expect(201);

    const subs = await activeSubs(studio.id, member.id);
    expect(subs).toHaveLength(2);
    const fullAfter = subs.find((s) => s.membershipPlanId === fullPlan.id)!;
    const booty = subs.find((s) => s.membershipPlanId === bootyPlan.id)!;
    expect(fullAfter.id).toBe(fullBefore.id);
    expect(fullAfter.status).toBe(SubscriptionStatus.ACTIVE);
    expect(fullAfter.endReason).toBeNull();
    expect(booty.exclusiveGroupKey).toBeNull();
    expect(fullAfter.exclusiveGroupKey).toBe(CORE_EXCLUSIVE_GROUP);
  });

  it('CORE + CORE: cash Basic sale supersedes ACTIVE Full (family plan change), Booty untouched', async () => {
    const { studio, fullPlan, basicPlan, bootyPlan } = await setupStudioWithPlans();
    const { member, adminToken } = await setupMemberAndAdmin(studio.id, 'core-core');

    await cashSale(studio.id, adminToken, member.id, fullPlan.id, 150000).expect(201);
    await cashSale(studio.id, adminToken, member.id, bootyPlan.id, 80000).expect(201);
    await cashSale(studio.id, adminToken, member.id, basicPlan.id, 100000).expect(201);

    const subs = await activeSubs(studio.id, member.id);
    expect(subs.map((s) => s.membershipPlanId).sort()).toEqual([basicPlan.id, bootyPlan.id].sort());

    const fullRow = await prisma.subscription.findFirst({
      where: { studioId: studio.id, userId: member.id, membershipPlanId: fullPlan.id },
    });
    expect(fullRow!.status).toBe(SubscriptionStatus.CANCELED);
    expect(fullRow!.endReason).toBe(SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE);

    const bootyRow = subs.find((s) => s.membershipPlanId === bootyPlan.id)!;
    expect(bootyRow.endReason).toBeNull();
  });

  it('same-plan duplicate: DB final defense rejects a second ACTIVE row for the same plan even if app checks were bypassed', async () => {
    const { studio, fullPlan } = await setupStudioWithPlans();
    const { member } = await setupMemberAndAdmin(studio.id, 'dup-plan');

    await prisma.subscription.create({
      data: {
        studioId: studio.id, userId: member.id, membershipPlanId: fullPlan.id,
        status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH,
        exclusiveGroupKey: CORE_EXCLUSIVE_GROUP,
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    await expect(
      prisma.subscription.create({
        data: {
          studioId: studio.id, userId: member.id, membershipPlanId: fullPlan.id,
          status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH,
          exclusiveGroupKey: CORE_EXCLUSIVE_GROUP,
          currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('same-group duplicate: DB final defense rejects a second ACTIVE CORE row (Full + Basic) even if app checks were bypassed', async () => {
    const { studio, fullPlan, basicPlan } = await setupStudioWithPlans();
    const { member } = await setupMemberAndAdmin(studio.id, 'dup-group');

    await prisma.subscription.create({
      data: {
        studioId: studio.id, userId: member.id, membershipPlanId: fullPlan.id,
        status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH,
        exclusiveGroupKey: CORE_EXCLUSIVE_GROUP,
        currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    await expect(
      prisma.subscription.create({
        data: {
          studioId: studio.id, userId: member.id, membershipPlanId: basicPlan.id,
          status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH,
          exclusiveGroupKey: CORE_EXCLUSIVE_GROUP,
          currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('duplicate Booty renewal routes to renew-in-place: only one ACTIVE Booty row after a second cash sale', async () => {
    const { studio, bootyPlan } = await setupStudioWithPlans();
    const { member, adminToken } = await setupMemberAndAdmin(studio.id, 'booty-renew');

    await cashSale(studio.id, adminToken, member.id, bootyPlan.id, 80000).expect(201);
    await cashSale(studio.id, adminToken, member.id, bootyPlan.id, 80000).expect(201);

    const bootyRows = await prisma.subscription.findMany({
      where: { studioId: studio.id, userId: member.id, membershipPlanId: bootyPlan.id },
    });
    expect(bootyRows.filter((r) => r.status === SubscriptionStatus.ACTIVE)).toHaveLength(1);
  });

  it('concurrent same-plan cash purchases: exactly one ACTIVE row survives (advisory lock + DB index)', async () => {
    const { studio, fullPlan } = await setupStudioWithPlans();
    const { member, adminToken } = await setupMemberAndAdmin(studio.id, 'race');

    const [a, b] = await Promise.all([
      cashSale(studio.id, adminToken, member.id, fullPlan.id, 150000),
      cashSale(studio.id, adminToken, member.id, fullPlan.id, 150000),
    ]);
    // Both may 201 (second becomes renewal/supersede) or one may 409 — but never two ACTIVE.
    expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(true);
    const subs = await activeSubs(studio.id, member.id);
    expect(subs).toHaveLength(1);
  });

  // ── Stripe legs (simulated webhooks through the real service) ─────────────

  it('Stripe Full + Stripe Booty: the second COMPATIBLE webhook creates its own local row — never dropped', async () => {
    const { studio, fullPlan, bootyPlan } = await setupStudioWithPlans();
    const { member } = await setupMemberAndAdmin(studio.id, 'stripe-stripe');

    const md = (planId: string) => ({ userId: member.id, studioId: studio.id, planId });
    await webhookService.upsertSubscriptionFromStripe(
      stripePayload('sub_full_1', studio.id, member.id, fullPlan.id), md(fullPlan.id), 'customer.subscription.created');
    await webhookService.upsertSubscriptionFromStripe(
      stripePayload('sub_booty_1', studio.id, member.id, bootyPlan.id), md(bootyPlan.id), 'customer.subscription.created');

    const rows = await prisma.subscription.findMany({
      where: { studioId: studio.id, userId: member.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.stripeSubscriptionId).sort()).toEqual(['sub_booty_1', 'sub_full_1']);
    // Booty is fixed-duration: not entitled until invoice.paid creates a cycle → PAST_DUE.
    expect(rows.find((r) => r.stripeSubscriptionId === 'sub_full_1')!.status).toBe(SubscriptionStatus.ACTIVE);
  });

  it('webhook replay is idempotent: same payload twice → still exactly one row per Stripe subscription', async () => {
    const { studio, fullPlan } = await setupStudioWithPlans();
    const { member } = await setupMemberAndAdmin(studio.id, 'replay');
    const md = { userId: member.id, studioId: studio.id, planId: fullPlan.id };
    const payload = stripePayload('sub_replay_1', studio.id, member.id, fullPlan.id);

    await webhookService.upsertSubscriptionFromStripe(payload, md, 'customer.subscription.created');
    await webhookService.upsertSubscriptionFromStripe(payload, md, 'customer.subscription.updated');

    const rows = await prisma.subscription.findMany({ where: { stripeSubscriptionId: 'sub_replay_1' } });
    expect(rows).toHaveLength(1);
  });

  it('subscription.updated touches ONLY its own row: Booty webhook update leaves Full untouched', async () => {
    const { studio, fullPlan, bootyPlan } = await setupStudioWithPlans();
    const { member } = await setupMemberAndAdmin(studio.id, 'update-isolation');
    const md = (planId: string) => ({ userId: member.id, studioId: studio.id, planId });

    await webhookService.upsertSubscriptionFromStripe(
      stripePayload('sub_full_u', studio.id, member.id, fullPlan.id), md(fullPlan.id), 'customer.subscription.created');
    await webhookService.upsertSubscriptionFromStripe(
      stripePayload('sub_booty_u', studio.id, member.id, bootyPlan.id), md(bootyPlan.id), 'customer.subscription.created');

    const fullBefore = await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: 'sub_full_u' } });

    const bootyUpdate = { ...stripePayload('sub_booty_u', studio.id, member.id, bootyPlan.id), cancel_at_period_end: true };
    await webhookService.upsertSubscriptionFromStripe(bootyUpdate, md(bootyPlan.id), 'customer.subscription.updated');

    const fullAfter = await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: 'sub_full_u' } });
    const bootyAfter = await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: 'sub_booty_u' } });
    expect(bootyAfter.cancelAtPeriodEnd).toBe(true);
    expect(fullAfter.cancelAtPeriodEnd).toBe(false);
    expect(fullAfter.status).toBe(fullBefore.status);
    expect(fullAfter.updatedAt.getTime()).toBe(fullBefore.updatedAt.getTime());
  });

  it('Stripe Full ACTIVE + cash Booty sale: compatible cross-source purchase does not demand a Stripe resolution', async () => {
    const { studio, fullPlan, bootyPlan } = await setupStudioWithPlans();
    const { member, adminToken } = await setupMemberAndAdmin(studio.id, 'stripe-cash');
    const md = { userId: member.id, studioId: studio.id, planId: fullPlan.id };
    await webhookService.upsertSubscriptionFromStripe(
      stripePayload('sub_full_sc', studio.id, member.id, fullPlan.id), md, 'customer.subscription.created');

    await cashSale(studio.id, adminToken, member.id, bootyPlan.id, 80000).expect(201);

    const subs = await activeSubs(studio.id, member.id);
    expect(subs).toHaveLength(2);
    const full = subs.find((s) => s.membershipPlanId === fullPlan.id)!;
    expect(full.stripeSubscriptionId).toBe('sub_full_sc');
    expect(full.cancelAtPeriodEnd).toBe(false);
  });

  // ── Entitlement aggregation + attribution (MM-2) ──────────────────────────

  async function setupFullPlusBooty(prefix: string) {
    const fixtures = await setupStudioWithPlans();
    const people = await setupMemberAndAdmin(fixtures.studio.id, prefix);
    await cashSale(fixtures.studio.id, people.adminToken, people.member.id, fixtures.fullPlan.id, 150000).expect(201);
    await cashSale(fixtures.studio.id, people.adminToken, people.member.id, fixtures.bootyPlan.id, 80000).expect(201);
    const subs = await activeSubs(fixtures.studio.id, people.member.id);
    const fullSub = subs.find((s) => s.membershipPlanId === fixtures.fullPlan.id)!;
    const bootySub = subs.find((s) => s.membershipPlanId === fixtures.bootyPlan.id)!;
    return { ...fixtures, ...people, fullSub, bootySub };
  }

  async function createClass(studioId: string, templateId: string, startsInHours = 24) {
    const startsAt = new Date(Date.now() + startsInHours * 3_600_000);
    return prisma.scheduledClass.create({
      data: {
        studioId, classTemplateId: templateId, capacity: 10, status: ClassStatus.SCHEDULED,
        startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000),
      },
    });
  }

  it('a Full-covered class books against Full and never consumes Booty credits', async () => {
    const ctx = await setupFullPlusBooty('attr-full');
    const cls = await createClass(ctx.studio.id, ctx.generalTemplate.id);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${ctx.studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${ctx.memberToken}`)
      .expect(201);

    const booking = await prisma.booking.findFirstOrThrow({
      where: { studioId: ctx.studio.id, userId: ctx.member.id, scheduledClassId: cls.id },
    });
    expect(booking.subscriptionId).toBe(ctx.fullSub.id);

    // Booty's 4 credits are untouched: subscription-scoped count sees zero consumption.
    const bootyUsed = await countScoped(ctx.studio.id, ctx.member.id, ctx.bootySub.id);
    expect(bootyUsed).toBe(0);
  });

  it('a Booty-only class books against Booty and consumes exactly one Booty credit', async () => {
    const ctx = await setupFullPlusBooty('attr-booty');
    const cls = await createClass(ctx.studio.id, ctx.bootyTemplate.id);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${ctx.studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${ctx.memberToken}`)
      .expect(201);

    const booking = await prisma.booking.findFirstOrThrow({
      where: { studioId: ctx.studio.id, userId: ctx.member.id, scheduledClassId: cls.id },
    });
    expect(booking.subscriptionId).toBe(ctx.bootySub.id);

    expect(await countScoped(ctx.studio.id, ctx.member.id, ctx.bootySub.id)).toBe(1);
    expect(await countScoped(ctx.studio.id, ctx.member.id, ctx.fullSub.id)).toBe(0);
  });

  it('a class included by BOTH plans books against the unlimited membership (never wastes scarce credits)', async () => {
    const ctx = await setupFullPlusBooty('attr-shared');
    // Grant Full access to the Booty template too — now both plans include it.
    await prisma.membershipPlanClassAccess.create({
      data: { studioId: ctx.studio.id, membershipPlanId: ctx.fullPlan.id, classTemplateId: ctx.bootyTemplate.id },
    });
    const cls = await createClass(ctx.studio.id, ctx.bootyTemplate.id);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${ctx.studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${ctx.memberToken}`)
      .expect(201);

    const booking = await prisma.booking.findFirstOrThrow({
      where: { studioId: ctx.studio.id, userId: ctx.member.id, scheduledClassId: cls.id },
    });
    expect(booking.subscriptionId).toBe(ctx.fullSub.id);
    expect(await countScoped(ctx.studio.id, ctx.member.id, ctx.bootySub.id)).toBe(0);
  });

  it('manual walk-in attendance on a Booty class is attributed to the Booty subscription', async () => {
    const ctx = await setupFullPlusBooty('attr-manual');
    const cls = await createClass(ctx.studio.id, ctx.bootyTemplate.id, 1);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${ctx.studio.id}/classes/${cls.id}/manual-attendance`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .send({ memberId: ctx.member.id })
      .expect(201);

    const attendance = await prisma.attendance.findFirstOrThrow({
      where: { studioId: ctx.studio.id, userId: ctx.member.id, scheduledClassId: cls.id },
    });
    expect(attendance.subscriptionId).toBe(ctx.bootySub.id);
  });

  it('legacy NULL-attribution rows still count for a single-membership member (usage unchanged pre/post)', async () => {
    const fixtures = await setupStudioWithPlans();
    const { member, adminToken } = await setupMemberAndAdmin(fixtures.studio.id, 'legacy-null');
    await cashSale(fixtures.studio.id, adminToken, member.id, fixtures.bootyPlan.id, 80000).expect(201);
    const bootySub = (await activeSubs(fixtures.studio.id, member.id))[0]!;

    // Simulate a pre-migration historical booking: consuming status, NULL attribution.
    const cls = await createClass(fixtures.studio.id, fixtures.bootyTemplate.id, 2);
    await prisma.booking.create({
      data: {
        studioId: fixtures.studio.id, scheduledClassId: cls.id, userId: member.id,
        status: BookingStatus.CONFIRMED, subscriptionId: null,
      },
    });

    // Scoped count includes the legacy NULL row — identical to the pre-MM behavior.
    expect(await countScoped(fixtures.studio.id, member.id, bootySub.id)).toBe(1);
  });

  // ── Cancellation isolation ────────────────────────────────────────────────

  it('cancelling Full leaves Booty ACTIVE and entitled; cancelling Booty leaves Full ACTIVE', async () => {
    const ctx = await setupFullPlusBooty('cancel-isolation');

    await prisma.subscription.update({
      where: { id: ctx.fullSub.id },
      data: { status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.MEMBER_CANCELLED },
    });
    let booty = await prisma.subscription.findUniqueOrThrow({ where: { id: ctx.bootySub.id } });
    expect(booty.status).toBe(SubscriptionStatus.ACTIVE);
    expect(booty.endReason).toBeNull();

    // Reset and test the reverse direction.
    await prisma.subscription.update({
      where: { id: ctx.fullSub.id },
      data: { status: SubscriptionStatus.ACTIVE, endReason: null },
    });
    await prisma.subscription.update({
      where: { id: ctx.bootySub.id },
      data: { status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.MEMBER_CANCELLED },
    });
    const full = await prisma.subscription.findUniqueOrThrow({ where: { id: ctx.fullSub.id } });
    expect(full.status).toBe(SubscriptionStatus.ACTIVE);
    expect(full.endReason).toBeNull();
    booty = await prisma.subscription.findUniqueOrThrow({ where: { id: ctx.bootySub.id } });
    expect(booty.status).toBe(SubscriptionStatus.CANCELED);
  });

  // ── API back-compat foundation ────────────────────────────────────────────

  it('member profile (/members/me) carries BOTH memberships plus a CORE-primary activeSubscription', async () => {
    const ctx = await setupFullPlusBooty('profile-both');

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${ctx.studio.id}/members/me`)
      .set('Authorization', `Bearer ${ctx.memberToken}`)
      .expect(200);

    const body = res.body as {
      activeSubscription: { id: string; plan: { id: string } } | null;
      currentMembership: { id: string } | null;
      memberships: Array<{ subscriptionId: string; membershipPlanId: string; exclusiveGroup: string | null; isEntitled: boolean; creditsRemaining: number | null }>;
    };

    expect(body.memberships).toHaveLength(2);
    const planIds = body.memberships.map((m) => m.membershipPlanId).sort();
    expect(planIds).toEqual([ctx.bootyPlan.id, ctx.fullPlan.id].sort());

    // Canonical PRIMARY: the CORE membership, not the newer stackable one.
    expect(body.activeSubscription?.id).toBe(ctx.fullSub.id);
    expect(body.currentMembership?.id).toBe(ctx.fullSub.id);

    const bootySummary = body.memberships.find((m) => m.membershipPlanId === ctx.bootyPlan.id)!;
    expect(bootySummary.exclusiveGroup).toBeNull();
    expect(bootySummary.isEntitled).toBe(true);
    expect(bootySummary.creditsRemaining).toBe(4);
  });

  it('single-membership members see identical singular fields (no behavior change)', async () => {
    const fixtures = await setupStudioWithPlans();
    const { member, memberToken, adminToken } = await setupMemberAndAdmin(fixtures.studio.id, 'single-compat');
    await cashSale(fixtures.studio.id, adminToken, member.id, fixtures.fullPlan.id, 150000).expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${fixtures.studio.id}/members/me`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);

    const body = res.body as {
      activeSubscription: { plan: { id: string } } | null;
      memberships: Array<{ membershipPlanId: string }>;
    };
    expect(body.activeSubscription?.plan.id).toBe(fixtures.fullPlan.id);
    expect(body.memberships).toHaveLength(1);
  });

  // ── Open Gym union (MM-2 regression) ──────────────────────────────────────

  it('Open Gym: Booty Lab (no Open Gym) never narrows Full Access\'s Open Gym entitlement', async () => {
    const fixtures = await setupStudioWithPlans();
    await prisma.membershipPlan.update({
      where: { id: fixtures.fullPlan.id },
      data: { openGymAccess: true, openGymWindowStart: null, openGymWindowEnd: null },
    });
    const ctx = await setupMemberAndAdmin(fixtures.studio.id, 'open-gym-union');
    await cashSale(fixtures.studio.id, ctx.adminToken, ctx.member.id, fixtures.fullPlan.id, 150000).expect(201);
    await cashSale(fixtures.studio.id, ctx.adminToken, ctx.member.id, fixtures.bootyPlan.id, 80000).expect(201);

    // Union across entitled memberships — resolved exactly as the door scan resolves it.
    const subs = await prisma.subscription.findMany({
      where: { studioId: fixtures.studio.id, userId: ctx.member.id, status: SubscriptionStatus.ACTIVE },
      select: { membershipPlan: { select: { id: true, name: true, openGymAccess: true, openGymWindowStart: true, openGymWindowEnd: true } } },
    });
    const anyOpenGym = subs.some((s) => s.membershipPlan.openGymAccess);
    expect(subs).toHaveLength(2);
    expect(anyOpenGym).toBe(true);
  });

  // Subscription-scoped consumption via the real service SQL.
  async function countScoped(studioId: string, userId: string, subscriptionId: string): Promise<number> {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT b.scheduled_class_id FROM bookings b
        WHERE b.studio_id = ${studioId} AND b.user_id = ${userId}
          AND b.status IN ('CONFIRMED'::"BookingStatus", 'COMPLETED'::"BookingStatus")
          AND (b.subscription_id = ${subscriptionId} OR b.subscription_id IS NULL)
        UNION
        SELECT a.scheduled_class_id FROM attendances a
        WHERE a.studio_id = ${studioId} AND a.user_id = ${userId}
          AND a.scheduled_class_id IS NOT NULL
          AND (a.subscription_id = ${subscriptionId} OR a.subscription_id IS NULL)
      ) consumed
    `);
    return Number(rows[0]?.count ?? 0n);
  }
});
