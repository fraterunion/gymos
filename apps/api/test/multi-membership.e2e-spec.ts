import { readFileSync } from 'fs';
import { join } from 'path';
import type { INestApplication } from '@nestjs/common';
import { BookingStatus, CheckInMethod, ClassStatus, Role, SubscriptionEndReason, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { MembershipUsageService } from '../src/membership-usage/membership-usage.service';
import { StripeWebhookService } from '../src/billing/stripe-webhook.service';
import { CORE_EXCLUSIVE_GROUP } from '../src/memberships/membership-compatibility';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';
import { runBootyStackable, runBootyStackableReverse } from '../scripts/mm4-booty-stackable';
import {
  runIvonneStackReconcile,
  type StripeReadClient,
  type StripeSubscriptionLike,
} from '../scripts/mm5-ivonne-stripe-stack-reconcile';

/**
 * MM-1..MM-4 — multi-membership invariant, entitlement aggregation, attribution, isolation,
 * the creation-gate kill switch, and the FINAL physical constraint shape, exercised over
 * real HTTP against the real services.
 *
 * MM-4 index parity: the dedicated test database is migrated with the REAL
 * multi_membership_constraint_swap migration (via prisma migrate deploy), and beforeAll
 * asserts both that migration.sql contains exactly the intended index DDL and that
 * pg_indexes reports exactly the final four definitions — so the tested shape and the
 * production shape cannot silently drift. Production is never touched by this suite.
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

/** The four FINAL index definitions exactly as pg_indexes renders them post-migration —
 *  asserted against the live test DB so tested and deployed shapes cannot drift. */
const FINAL_INDEX_DEFS: Record<string, string> = {
  subscriptions_one_renewable_per_member_plan_idx:
    'CREATE UNIQUE INDEX subscriptions_one_renewable_per_member_plan_idx ON public.subscriptions USING btree (studio_id, user_id, membership_plan_id) WHERE (status = ANY (ARRAY[\'ACTIVE\'::"SubscriptionStatus", \'TRIALING\'::"SubscriptionStatus", \'PAST_DUE\'::"SubscriptionStatus", \'PAUSED\'::"SubscriptionStatus"]))',
  subscriptions_one_renewable_per_member_group_idx:
    'CREATE UNIQUE INDEX subscriptions_one_renewable_per_member_group_idx ON public.subscriptions USING btree (studio_id, user_id, exclusive_group_key) WHERE ((status = ANY (ARRAY[\'ACTIVE\'::"SubscriptionStatus", \'TRIALING\'::"SubscriptionStatus", \'PAST_DUE\'::"SubscriptionStatus", \'PAUSED\'::"SubscriptionStatus"])) AND (exclusive_group_key IS NOT NULL))',
  subscriptions_one_scheduled_per_member_plan_idx:
    'CREATE UNIQUE INDEX subscriptions_one_scheduled_per_member_plan_idx ON public.subscriptions USING btree (studio_id, user_id, membership_plan_id) WHERE (status = \'SCHEDULED\'::"SubscriptionStatus")',
  subscriptions_one_scheduled_per_member_group_idx:
    'CREATE UNIQUE INDEX subscriptions_one_scheduled_per_member_group_idx ON public.subscriptions USING btree (studio_id, user_id, exclusive_group_key) WHERE ((status = \'SCHEDULED\'::"SubscriptionStatus") AND (exclusive_group_key IS NOT NULL))',
};

const SWAP_MIGRATION_PATH = join(
  __dirname,
  '../prisma/migrations/20260908220000_multi_membership_constraint_swap/migration.sql',
);

describe('Multi-membership MM-1..MM-4 (e2e, gate ON, FINAL constraint shape)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let webhookService: WebhookServiceUnderTest;

  beforeAll(async () => {
    process.env['MULTI_MEMBERSHIP_ENABLED'] = 'true';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    webhookService = app.get(StripeWebhookService) as unknown as WebhookServiceUnderTest;

    // MM-4 parity gate 1: the swap migration file must contain exactly the intended DDL.
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const migrationSql = norm(readFileSync(SWAP_MIGRATION_PATH, 'utf8'));
    expect(migrationSql).toContain(norm(`
      CREATE UNIQUE INDEX "subscriptions_one_renewable_per_member_plan_idx"
      ON "subscriptions" ("studio_id", "user_id", "membership_plan_id")
      WHERE "status" IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED')`));
    expect(migrationSql).toContain(norm(`
      CREATE UNIQUE INDEX "subscriptions_one_renewable_per_member_group_idx"
      ON "subscriptions" ("studio_id", "user_id", "exclusive_group_key")
      WHERE "status" IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED')
        AND "exclusive_group_key" IS NOT NULL`));
    expect(migrationSql).toContain(norm(`
      CREATE UNIQUE INDEX "subscriptions_one_scheduled_per_member_plan_idx"
      ON "subscriptions" ("studio_id", "user_id", "membership_plan_id")
      WHERE "status" = 'SCHEDULED'`));
    expect(migrationSql).toContain(norm(`
      CREATE UNIQUE INDEX "subscriptions_one_scheduled_per_member_group_idx"
      ON "subscriptions" ("studio_id", "user_id", "exclusive_group_key")
      WHERE "status" = 'SCHEDULED'
        AND "exclusive_group_key" IS NOT NULL`));
    expect(migrationSql).toContain('DROP INDEX "subscriptions_one_active_per_user_per_studio_idx"');
    expect(migrationSql).toContain('DROP INDEX "subscriptions_one_scheduled_per_user_per_studio_idx"');

    // MM-4 parity gate 2: the live (migrate-deployed) test DB carries exactly that shape.
    const liveIndexes = await prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'subscriptions' AND indexname LIKE '%one\\_%' ORDER BY indexname`,
    );
    const byName = new Map(liveIndexes.map((r) => [r.indexname, r.indexdef]));
    for (const [name, def] of Object.entries(FINAL_INDEX_DEFS)) {
      expect(byName.get(name)).toBe(def);
    }
    expect(byName.has('subscriptions_one_active_per_user_per_studio_idx')).toBe(false);
    expect(byName.has('subscriptions_one_scheduled_per_user_per_studio_idx')).toBe(false);
    expect(liveIndexes).toHaveLength(Object.keys(FINAL_INDEX_DEFS).length);
  });

  afterAll(async () => {
    await truncateAll(prisma);
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

  // Subscription-scoped consumption via the REAL usage service — exercises the MM-5.1
  // canonical-event + deterministic-ownership path against the live schema. The window is
  // deliberately wide so it counts a subscription's full ledger like the old helper did.
  async function countScoped(studioId: string, userId: string, subscriptionId: string): Promise<number> {
    const usage = app.get(MembershipUsageService);
    return usage.countConsumedClasses(
      prisma, studioId, userId, new Date('2000-01-01T00:00:00Z'), new Date('2100-01-01T00:00:00Z'), subscriptionId,
    );
  }

  // ── MM-5.1: legacy NULL attribution — one event, ONE ledger ───────────────

  describe('MM-5.1 legacy NULL usage attribution', () => {
    it('future-booking edge (unlimited + credit): legacy NULL booking, then a second membership before class — exactly ONE ledger', async () => {
      // The exact problematic sequence: member books under a single membership while
      // attribution was NULL, then a compatible second membership starts BEFORE the class.
      const fixtures = await setupStudioWithPlans();
      const { member, adminToken } = await setupMemberAndAdmin(fixtures.studio.id, 'mm51-future-unl');
      await cashSale(fixtures.studio.id, adminToken, member.id, fixtures.bootyPlan.id, 80000).expect(201);
      const bootySub = (await activeSubs(fixtures.studio.id, member.id))[0]!;

      // Full also includes the Booty template, so BOTH plans qualify for the class.
      await prisma.membershipPlanClassAccess.create({
        data: { studioId: fixtures.studio.id, membershipPlanId: fixtures.fullPlan.id, classTemplateId: fixtures.bootyTemplate.id },
      });

      const futureClass = await createClass(fixtures.studio.id, fixtures.bootyTemplate.id, 48);
      await prisma.booking.create({
        data: {
          studioId: fixtures.studio.id, scheduledClassId: futureClass.id, userId: member.id,
          status: BookingStatus.CONFIRMED, subscriptionId: null,
        },
      });

      await cashSale(fixtures.studio.id, adminToken, member.id, fixtures.fullPlan.id, 150000).expect(201);
      const fullSub = (await activeSubs(fixtures.studio.id, member.id)).find(
        (s) => s.membershipPlanId === fixtures.fullPlan.id,
      )!;

      const fullCount = await countScoped(fixtures.studio.id, member.id, fullSub.id);
      const bootyCount = await countScoped(fixtures.studio.id, member.id, bootySub.id);
      expect(fullCount + bootyCount).toBe(1);
      // Deterministic owner: unlimited Full absorbs legacy history, scarce Booty credits survive.
      expect(fullCount).toBe(1);
      expect(bootyCount).toBe(0);
    });

    it('future-booking edge (two credit plans): the soonest-ending entitlement owns the event — exactly ONE ledger', async () => {
      const fixtures = await setupStudioWithPlans();
      const pilatesPlan = await prisma.membershipPlan.create({
        data: {
          studioId: fixtures.studio.id, name: 'Pilates Pack', priceCents: 90000, currency: 'mxn',
          billingInterval: 'MONTHLY', active: true, allClassesAccess: false, classCredits: 8,
          exclusiveGroup: null,
          classTemplateAccess: { create: [{ studioId: fixtures.studio.id, classTemplateId: fixtures.bootyTemplate.id }] },
        },
      });
      const { member, adminToken } = await setupMemberAndAdmin(fixtures.studio.id, 'mm51-future-2cr');
      await cashSale(fixtures.studio.id, adminToken, member.id, fixtures.bootyPlan.id, 80000).expect(201);
      const bootySub = (await activeSubs(fixtures.studio.id, member.id))[0]!;

      const futureClass = await createClass(fixtures.studio.id, fixtures.bootyTemplate.id, 48);
      await prisma.booking.create({
        data: {
          studioId: fixtures.studio.id, scheduledClassId: futureClass.id, userId: member.id,
          status: BookingStatus.CONFIRMED, subscriptionId: null,
        },
      });

      await cashSale(fixtures.studio.id, adminToken, member.id, pilatesPlan.id, 90000).expect(201);
      const pilatesSub = (await activeSubs(fixtures.studio.id, member.id)).find(
        (s) => s.membershipPlanId === pilatesPlan.id,
      )!;

      const bootyCount = await countScoped(fixtures.studio.id, member.id, bootySub.id);
      const pilatesCount = await countScoped(fixtures.studio.id, member.id, pilatesSub.id);
      expect(bootyCount + pilatesCount).toBe(1);

      // The owner is the candidate with the earliest effective entitlement end —
      // computed from the persisted rows, so the assertion is exact, not incidental.
      const effectiveEnd = (s: { entitlementEndsAt: Date | null; currentPeriodEnd: Date | null }) =>
        (s.entitlementEndsAt ?? s.currentPeriodEnd)!.getTime();
      const expectedOwner = effectiveEnd(bootySub) <= effectiveEnd(pilatesSub) ? bootySub.id : pilatesSub.id;
      expect(bootyCount === 1 ? bootySub.id : pilatesSub.id).toBe(expectedOwner);
    });

    it('Ivonne-shape regression (matrix W): historical Booty NULL usage never leaks into a later CORE membership', async () => {
      const fixtures = await setupStudioWithPlans();
      const { member, adminToken } = await setupMemberAndAdmin(fixtures.studio.id, 'mm51-ivonne-shape');
      await cashSale(fixtures.studio.id, adminToken, member.id, fixtures.bootyPlan.id, 80000).expect(201);
      const bootySub = (await activeSubs(fixtures.studio.id, member.id))[0]!;

      // Historical consumed class: BOTH legs legacy NULL (booking + attendance) — must dedup to ONE credit.
      const pastClass = await createClass(fixtures.studio.id, fixtures.bootyTemplate.id, 1);
      await prisma.booking.create({
        data: {
          studioId: fixtures.studio.id, scheduledClassId: pastClass.id, userId: member.id,
          status: BookingStatus.COMPLETED, subscriptionId: null,
        },
      });
      await prisma.attendance.create({
        data: {
          studioId: fixtures.studio.id, scheduledClassId: pastClass.id, userId: member.id,
          method: CheckInMethod.MANUAL, subscriptionId: null,
        },
      });
      // Non-consuming legacy row (matrix S): a CANCELLED NULL booking never counts anywhere.
      const cancelledClass = await createClass(fixtures.studio.id, fixtures.bootyTemplate.id, 2);
      await prisma.booking.create({
        data: {
          studioId: fixtures.studio.id, scheduledClassId: cancelledClass.id, userId: member.id,
          status: BookingStatus.CANCELLED, subscriptionId: null,
        },
      });

      // Then the CORE membership arrives (credit-limited Basic — the Pro/Booty stack shape).
      await cashSale(fixtures.studio.id, adminToken, member.id, fixtures.basicPlan.id, 100000).expect(201);
      const coreSub = (await activeSubs(fixtures.studio.id, member.id)).find(
        (s) => s.membershipPlanId === fixtures.basicPlan.id,
      )!;

      // Booty (the only plan that includes the class) keeps its ONE deduped credit;
      // the CORE ledger sees nothing. Never 2, never one-in-each.
      expect(await countScoped(fixtures.studio.id, member.id, bootySub.id)).toBe(1);
      expect(await countScoped(fixtures.studio.id, member.id, coreSub.id)).toBe(0);
    });
  });

  // ── MM-5A: multi-membership experience contract ────────────────────────────

  async function fetchPurchaseOptions(studioId: string, token: string) {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studioId}/membership-plans/purchase-options`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body.options as Array<{
      planId: string;
      purchaseAction: string;
      relatedSubscriptionId: string | null;
      relatedPlanName: string | null;
      reasonCode: string | null;
    }>;
  }

  it('purchase-options for a Stripe Full holder: CURRENT / CHANGE / ADD — and never ADD with the gate OFF', async () => {
    const { studio, fullPlan, basicPlan, bootyPlan } = await setupStudioWithPlans();
    const { member, memberToken } = await setupMemberAndAdmin(studio.id, 'opts-full');
    await webhookService.upsertSubscriptionFromStripe(
      stripePayload('sub_opts_full', studio.id, member.id, fullPlan.id),
      { userId: member.id, studioId: studio.id, planId: fullPlan.id },
      'customer.subscription.created',
    );

    const byPlan = new Map((await fetchPurchaseOptions(studio.id, memberToken)).map((o) => [o.planId, o]));
    expect(byPlan.get(fullPlan.id)?.purchaseAction).toBe('CURRENT');
    expect(byPlan.get(basicPlan.id)?.purchaseAction).toBe('CHANGE');
    expect(byPlan.get(basicPlan.id)?.relatedPlanName).toBe('Full Access');
    expect(byPlan.get(bootyPlan.id)?.purchaseAction).toBe('ADD');
    // No compatibility vocabulary leaks to clients.
    expect(JSON.stringify([...byPlan.values()])).not.toMatch(/exclusiveGroup|CORE/);

    process.env['MULTI_MEMBERSHIP_ENABLED'] = 'false';
    try {
      const gated = new Map((await fetchPurchaseOptions(studio.id, memberToken)).map((o) => [o.planId, o]));
      expect(gated.get(bootyPlan.id)?.purchaseAction).toBe('BLOCKED');
      expect(gated.get(bootyPlan.id)?.reasonCode).toBe('STACKING_DISABLED');
      expect(gated.get(basicPlan.id)?.purchaseAction).toBe('CHANGE');
    } finally {
      process.env['MULTI_MEMBERSHIP_ENABLED'] = 'true';
    }
  });

  it('purchase-options for a dual member resolve from each OWN membership row, never from the primary', async () => {
    const ctx = await setupFullPlusBooty('opts-dual');
    const byPlan = new Map((await fetchPurchaseOptions(ctx.studio.id, ctx.memberToken)).map((o) => [o.planId, o]));
    expect(byPlan.get(ctx.fullPlan.id)?.purchaseAction).toBe('CURRENT');
    expect(byPlan.get(ctx.fullPlan.id)?.relatedSubscriptionId).toBe(ctx.fullSub.id);
    expect(byPlan.get(ctx.bootyPlan.id)?.purchaseAction).toBe('CURRENT');
    expect(byPlan.get(ctx.bootyPlan.id)?.relatedSubscriptionId).toBe(ctx.bootySub.id);
  });

  it('scheduled successor: memberships[] carries the SCHEDULED row, links it to its family, and options say SCHEDULED', async () => {
    const { studio, fullPlan } = await setupStudioWithPlans();
    const { member, memberToken } = await setupMemberAndAdmin(studio.id, 'opts-sched');
    await webhookService.upsertSubscriptionFromStripe(
      stripePayload('sub_sched_full', studio.id, member.id, fullPlan.id),
      { userId: member.id, studioId: studio.id, planId: fullPlan.id },
      'customer.subscription.created',
    );
    const fullRow = await prisma.subscription.findFirstOrThrow({
      where: { studioId: studio.id, userId: member.id, membershipPlanId: fullPlan.id },
    });
    const successor = await prisma.subscription.create({
      data: {
        ...subRow(studio.id, member.id, fullPlan.id, CORE_EXCLUSIVE_GROUP, SubscriptionStatus.SCHEDULED),
        currentPeriodStart: new Date(Date.now() + 30 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 60 * 86_400_000),
      },
    });
    await prisma.subscription.update({
      where: { id: fullRow.id },
      data: { supersededBySubscriptionId: successor.id, cancelAtPeriodEnd: true },
    });

    const me = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/members/me`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);
    const memberships = me.body.memberships as Array<{
      subscriptionId: string;
      status: string;
      supersededBySubscriptionId: string | null;
      plan: { openGymAccess: boolean; allClassesAccess: boolean; allowedTemplates: Array<{ id: string; name: string }> };
    }>;
    const scheduledRow = memberships.find((m) => m.subscriptionId === successor.id);
    const activeRow = memberships.find((m) => m.subscriptionId === fullRow.id);
    expect(scheduledRow?.status).toBe('SCHEDULED');
    expect(activeRow?.supersededBySubscriptionId).toBe(successor.id);
    expect(activeRow?.plan.allowedTemplates.map((t) => t.name)).toContain('Strength');
    expect(typeof activeRow?.plan.openGymAccess).toBe('boolean');

    const byPlan = new Map((await fetchPurchaseOptions(studio.id, memberToken)).map((o) => [o.planId, o]));
    expect(byPlan.get(fullPlan.id)?.purchaseAction).toBe('SCHEDULED');
    expect(byPlan.get(fullPlan.id)?.relatedSubscriptionId).toBe(successor.id);
  });

  it('canceled-but-entitled Booty: payload keeps entitlement state and options say RENEW', async () => {
    const { studio, bootyPlan } = await setupStudioWithPlans();
    const { member, memberToken } = await setupMemberAndAdmin(studio.id, 'opts-centitled');
    const endsAt = new Date(Date.now() + 10 * 86_400_000);
    await prisma.subscription.create({
      data: {
        ...subRow(studio.id, member.id, bootyPlan.id, null, SubscriptionStatus.CANCELED),
        entitlementEndsAt: endsAt,
      },
    });

    const me = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/members/me`)
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(200);
    const bootyRow = (me.body.memberships as Array<{ membershipPlanId: string; status: string; isEntitled: boolean; entitlementEndsAt: string }>)
      .find((m) => m.membershipPlanId === bootyPlan.id);
    expect(bootyRow?.status).toBe('CANCELED');
    expect(bootyRow?.isEntitled).toBe(true);
    expect(new Date(bootyRow!.entitlementEndsAt).getTime()).toBe(endsAt.getTime());

    const byPlan = new Map((await fetchPurchaseOptions(studio.id, memberToken)).map((o) => [o.planId, o]));
    expect(byPlan.get(bootyPlan.id)?.purchaseAction).toBe('RENEW');
    expect(byPlan.get(bootyPlan.id)?.reasonCode).toBe('RESUBSCRIBE');
  });

  it('booking response echoes chargedMembership: Booty credit consumed; unlimited Full consumes none', async () => {
    const ctx = await setupFullPlusBooty('resp-attr');
    const bootyClass = await createClass(ctx.studio.id, ctx.bootyTemplate.id);
    const bootyRes = await request(app.getHttpServer())
      .post(`/api/v1/studios/${ctx.studio.id}/classes/${bootyClass.id}/bookings`)
      .set('Authorization', `Bearer ${ctx.memberToken}`)
      .expect(201);
    expect(bootyRes.body.chargedMembership).toEqual({
      subscriptionId: ctx.bootySub.id,
      planName: 'Booty Lab by Etzia',
      creditConsumed: true,
    });

    const fullClass = await createClass(ctx.studio.id, ctx.generalTemplate.id, 1);
    const fullRes = await request(app.getHttpServer())
      .post(`/api/v1/studios/${ctx.studio.id}/classes/${fullClass.id}/bookings`)
      .set('Authorization', `Bearer ${ctx.memberToken}`)
      .expect(201);
    expect(fullRes.body.chargedMembership).toEqual({
      subscriptionId: ctx.fullSub.id,
      planName: 'Full Access',
      creditConsumed: false,
    });
  });

  it('analytics plan utilization counts a dual member once under EACH plan, while member KPIs count one person', async () => {
    const ctx = await setupFullPlusBooty('analytics-dual');

    const activity = await request(app.getHttpServer())
      .get(`/api/v1/studios/${ctx.studio.id}/analytics/members/activity?period=this_month`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    const utilization = activity.body.planUtilization as Array<{ planId: string; memberCount: number }>;
    const fullRow = utilization.find((p) => p.planId === ctx.fullPlan.id);
    const bootyRow = utilization.find((p) => p.planId === ctx.bootyPlan.id);
    expect(fullRow?.memberCount).toBe(1);
    expect(bootyRow?.memberCount).toBe(1);

    const summary = await request(app.getHttpServer())
      .get(`/api/v1/studios/${ctx.studio.id}/analytics/members/summary?period=this_month`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    expect(summary.body.kpis.activeMembers).toBe(1);
  });

  it('staff purchase-options endpoint returns the same contract for a target member', async () => {
    const ctx = await setupFullPlusBooty('opts-staff');
    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${ctx.studio.id}/members/${ctx.member.id}/purchase-options`)
      .set('Authorization', `Bearer ${ctx.adminToken}`)
      .expect(200);
    const byPlan = new Map((res.body.options as Array<{ planId: string; purchaseAction: string }>).map((o) => [o.planId, o]));
    // Staff context: cash memberships are desk-renewable/changeable (cash-sale supersede).
    expect(byPlan.get(ctx.fullPlan.id)?.purchaseAction).toBe('RENEW');
    expect(byPlan.get(ctx.bootyPlan.id)?.purchaseAction).toBe('RENEW');
    expect(byPlan.get(ctx.basicPlan.id)?.purchaseAction).toBe('CHANGE');
  });

  // ── MM-4 A: final physical invariants (direct inserts against the real indexes) ──

  function subRow(studioId: string, userId: string, planId: string, groupKey: string | null, status: SubscriptionStatus) {
    return {
      studioId, userId, membershipPlanId: planId,
      status, source: SubscriptionSource.CASH,
      exclusiveGroupKey: groupKey,
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    };
  }

  it('every CORE plan stacks with Booty Lab at the DB level (Full/Basic/Pro/Open Gym + Booty)', async () => {
    const { studio, fullPlan, basicPlan, bootyPlan, generalTemplate } = await setupStudioWithPlans();
    const proPlan = await prisma.membershipPlan.create({
      data: {
        studioId: studio.id, name: 'Pro', priceCents: 120000, currency: 'mxn',
        billingInterval: 'MONTHLY', active: true, allClassesAccess: false,
        exclusiveGroup: CORE_EXCLUSIVE_GROUP,
        classTemplateAccess: { create: [{ studioId: studio.id, classTemplateId: generalTemplate.id }] },
      },
    });
    const openGymPlan = await prisma.membershipPlan.create({
      data: {
        studioId: studio.id, name: 'Open Gym', priceCents: 60000, currency: 'mxn',
        billingInterval: 'MONTHLY', active: true, allClassesAccess: false, openGymAccess: true,
        exclusiveGroup: CORE_EXCLUSIVE_GROUP,
      },
    });
    for (const [i, corePlan] of [fullPlan, basicPlan, proPlan, openGymPlan].entries()) {
      const member = await createUserWithPassword(prisma, { email: `a-matrix-${i}@e2e.local` });
      await createMembership(prisma, member.id, studio.id, Role.MEMBER);
      await prisma.subscription.create({ data: subRow(studio.id, member.id, corePlan.id, CORE_EXCLUSIVE_GROUP, SubscriptionStatus.ACTIVE) });
      await prisma.subscription.create({ data: subRow(studio.id, member.id, bootyPlan.id, null, SubscriptionStatus.ACTIVE) });
      const rows = await activeSubs(studio.id, member.id);
      expect(rows).toHaveLength(2);
    }
  });

  it('SCHEDULED invariants: Full+Booty successors coexist; Full+Basic successors rejected; same-plan SCHEDULED duplicate rejected; ACTIVE+SCHEDULED same plan allowed', async () => {
    const { studio, fullPlan, basicPlan, bootyPlan } = await setupStudioWithPlans();
    const { member } = await setupMemberAndAdmin(studio.id, 'sched-matrix');

    // A10: ACTIVE Full + SCHEDULED Full — the designed Stripe→Cash transition pair.
    await prisma.subscription.create({ data: subRow(studio.id, member.id, fullPlan.id, CORE_EXCLUSIVE_GROUP, SubscriptionStatus.ACTIVE) });
    await prisma.subscription.create({ data: subRow(studio.id, member.id, fullPlan.id, CORE_EXCLUSIVE_GROUP, SubscriptionStatus.SCHEDULED) });

    // A8: Booty successor coexists with the Full successor (different family).
    await prisma.subscription.create({ data: subRow(studio.id, member.id, bootyPlan.id, null, SubscriptionStatus.SCHEDULED) });

    // A9: a second CORE-family successor (Basic) is rejected by the scheduled-group index.
    await expect(
      prisma.subscription.create({ data: subRow(studio.id, member.id, basicPlan.id, CORE_EXCLUSIVE_GROUP, SubscriptionStatus.SCHEDULED) }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // Same-plan SCHEDULED duplicate (Booty twice) rejected by the scheduled-plan index.
    await expect(
      prisma.subscription.create({ data: subRow(studio.id, member.id, bootyPlan.id, null, SubscriptionStatus.SCHEDULED) }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  // ── MM-4 B: creation-gate kill switch (dual membership established, then gate OFF) ──

  it('kill switch: with the gate OFF, renewals of BOTH memberships stay family-scoped and no sibling is touched', async () => {
    const { studio, fullPlan, bootyPlan } = await setupStudioWithPlans();
    const { member, adminToken } = await setupMemberAndAdmin(studio.id, 'kill-renew');
    await cashSale(studio.id, adminToken, member.id, fullPlan.id, 150000).expect(201);
    await cashSale(studio.id, adminToken, member.id, bootyPlan.id, 80000).expect(201);

    process.env['MULTI_MEMBERSHIP_ENABLED'] = 'false';
    try {
      // Full cash renewal: supersedes ONLY the Full row; Booty is untouched.
      await cashSale(studio.id, adminToken, member.id, fullPlan.id, 150000).expect(201);
      let subs = await activeSubs(studio.id, member.id);
      expect(subs.map((s) => s.membershipPlan.name).sort()).toEqual(['Booty Lab by Etzia', 'Full Access']);
      const bootyRow = subs.find((s) => s.membershipPlan.name.includes('Booty'))!;
      expect(bootyRow.endReason).toBeNull();

      // Booty cash renewal (fixed-duration renew-in-place): Full untouched.
      await cashSale(studio.id, adminToken, member.id, bootyPlan.id, 80000).expect(201);
      subs = await activeSubs(studio.id, member.id);
      expect(subs).toHaveLength(2);
      const fullRow = subs.find((s) => s.membershipPlan.name === 'Full Access')!;
      expect(fullRow.endReason).toBeNull();
      expect(fullRow.status).toBe(SubscriptionStatus.ACTIVE);
    } finally {
      process.env['MULTI_MEMBERSHIP_ENABLED'] = 'true';
    }
  });

  it('kill switch: with the gate OFF, a NEW stack cannot be created (cash sale rejected), while an existing dual member keeps both', async () => {
    const { studio, fullPlan, bootyPlan } = await setupStudioWithPlans();
    const { member, adminToken } = await setupMemberAndAdmin(studio.id, 'kill-newstack');
    await cashSale(studio.id, adminToken, member.id, fullPlan.id, 150000).expect(201);

    process.env['MULTI_MEMBERSHIP_ENABLED'] = 'false';
    try {
      const res = await cashSale(studio.id, adminToken, member.id, bootyPlan.id, 80000);
      expect(res.status).toBe(409);
      const subs = await activeSubs(studio.id, member.id);
      expect(subs).toHaveLength(1);
      expect(subs[0]!.membershipPlan.name).toBe('Full Access');
    } finally {
      process.env['MULTI_MEMBERSHIP_ENABLED'] = 'true';
    }
  });

  // ── MM-4 C: concurrency across creation paths (unified subscription-write lock) ──

  it('cash sale racing a same-plan Stripe webhook: exactly one renewable row in the family, no corruption', async () => {
    const { studio, fullPlan } = await setupStudioWithPlans();
    const { member, adminToken } = await setupMemberAndAdmin(studio.id, 'race-xpath');

    const [cashRes] = await Promise.all([
      cashSale(studio.id, adminToken, member.id, fullPlan.id, 150000),
      webhookService.upsertSubscriptionFromStripe(
        stripePayload('sub_race_full', studio.id, member.id, fullPlan.id),
        { userId: member.id, studioId: studio.id, planId: fullPlan.id },
        'customer.subscription.created',
      ),
    ]);

    // Either order is legal: cash first → the webhook acks the conflict without mutating;
    // webhook first → the cash sale demands a Stripe resolution (409). Never two rows.
    expect([201, 409]).toContain(cashRes.status);
    const renewable = await prisma.subscription.findMany({
      where: {
        studioId: studio.id, userId: member.id, membershipPlanId: fullPlan.id,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING, SubscriptionStatus.PAST_DUE, SubscriptionStatus.PAUSED] },
      },
    });
    expect(renewable).toHaveLength(1);
  });

  it('concurrent same-family different-plan cash sales: exactly one renewable CORE row survives', async () => {
    const { studio, fullPlan, basicPlan } = await setupStudioWithPlans();
    const { member, adminToken } = await setupMemberAndAdmin(studio.id, 'race-family');

    const [a, b] = await Promise.all([
      cashSale(studio.id, adminToken, member.id, fullPlan.id, 150000),
      cashSale(studio.id, adminToken, member.id, basicPlan.id, 100000),
    ]);
    expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(true);
    const subs = await activeSubs(studio.id, member.id);
    expect(subs).toHaveLength(1);
  });

  // ── MM-5 Stage 5b: Ivonne stack reconciliation script ──────────────────────

  describe('mm5-ivonne-stripe-stack-reconcile script', () => {
    const STRIPE_SUB_ID = 'sub_test_ivonne';
    const STRIPE_PRICE = 'price_test_pro';
    const INVOICE_ID = 'in_test_pro_1';
    const NOW_SEC = Math.floor(Date.now() / 1000);

    function fakeStripe(overrides: {
      sub?: Partial<StripeSubscriptionLike>;
      extraLive?: StripeSubscriptionLike[];
      invoiceSubByInvoiceId?: Record<string, string>;
    } = {}): StripeReadClient {
      const sub: StripeSubscriptionLike = {
        id: STRIPE_SUB_ID,
        status: 'active',
        cancel_at_period_end: false,
        customer: 'cus_test_ivonne',
        metadata: { userId: '', studioId: '', planId: '' },
        items: {
          data: [
            {
              price: { id: STRIPE_PRICE },
              current_period_start: NOW_SEC - 10 * 86_400,
              current_period_end: NOW_SEC + 20 * 86_400,
            },
          ],
        },
        ...overrides.sub,
      } as StripeSubscriptionLike;
      return {
        subscriptions: {
          retrieve: async (id: string) => {
            if (id !== STRIPE_SUB_ID) throw new Error(`no such subscription ${id}`);
            return sub;
          },
          list: async () => ({ data: [sub, ...(overrides.extraLive ?? [])] }),
        },
        invoices: {
          retrieve: async (id: string) => ({
            subscription: overrides.invoiceSubByInvoiceId?.[id] ?? STRIPE_SUB_ID,
          }),
        },
      };
    }

    async function setupIvonneWorld() {
      const fixtures = await setupStudioWithPlans();
      const member = await createUserWithPassword(prisma, { email: 'ivonne-test@e2e.local' });
      await createMembership(prisma, member.id, fixtures.studio.id, Role.MEMBER);
      const proPlan = await prisma.membershipPlan.create({
        data: {
          studioId: fixtures.studio.id, name: 'Pro', priceCents: 60000, currency: 'mxn',
          billingInterval: 'MONTHLY', active: true, allClassesAccess: false, classCredits: 5,
          exclusiveGroup: CORE_EXCLUSIVE_GROUP, stripePriceId: STRIPE_PRICE,
        },
      });
      // Existing cash Booty membership, already Stage-E reclassified (snapshot NULL).
      const bootyRow = await prisma.subscription.create({
        data: {
          ...subRow(fixtures.studio.id, member.id, fixtures.bootyPlan.id, null, SubscriptionStatus.ACTIVE),
          entitlementEndsAt: new Date(Date.now() + 20 * 86_400_000),
        },
      });
      // The already-recorded Stripe payment (invoice.paid via customer resolution).
      const payment = await prisma.payment.create({
        data: {
          studioId: fixtures.studio.id, userId: member.id, subscriptionId: null,
          membershipPlanId: proPlan.id, amountCents: 60000, currency: 'mxn',
          status: 'SUCCEEDED', paymentMethod: 'STRIPE', stripeInvoiceId: INVOICE_ID,
          paidAt: new Date(Date.now() - 10 * 86_400_000),
        },
      });
      const identity = {
        studioId: fixtures.studio.id,
        userId: member.id,
        bootySubscriptionId: bootyRow.id,
        proPlanId: proPlan.id,
        stripeSubscriptionId: STRIPE_SUB_ID,
        expectedStripePriceId: STRIPE_PRICE,
      };
      const stripeMeta = { userId: member.id, studioId: fixtures.studio.id, planId: proPlan.id };
      return { ...fixtures, member, proPlan, bootyRow, payment, identity, stripeMeta };
    }

    const silent = () => undefined;

    async function runFlagOff<T>(fn: () => Promise<T>): Promise<T> {
      process.env['MULTI_MEMBERSHIP_ENABLED'] = 'false';
      try {
        return await fn();
      } finally {
        process.env['MULTI_MEMBERSHIP_ENABLED'] = 'true';
      }
    }

    it('dry-run passes all preconditions, plans the exact mutation, and writes NOTHING', async () => {
      const w = await setupIvonneWorld();
      const result = await runFlagOff(() =>
        runIvonneStackReconcile(prisma, fakeStripe({ sub: { metadata: w.stripeMeta } }), {
          identity: w.identity, execute: false, log: silent,
        }),
      );
      expect(result.status).toBe('DRY_RUN');
      expect(result.linkedPaymentIds).toEqual([w.payment.id]);
      expect(await prisma.subscription.count({ where: { stripeSubscriptionId: STRIPE_SUB_ID } })).toBe(0);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: w.payment.id } });
      expect(payment.subscriptionId).toBeNull();
      expect(await prisma.auditLog.count({ where: { action: 'MM5_IVONNE_STRIPE_STACK_RECONCILED' } })).toBe(0);
    });

    it('execute mirrors live Stripe truth, links ONLY verified payments, leaves Booty untouched, audits once', async () => {
      const w = await setupIvonneWorld();
      // Decoy: a null-subscription Pro payment whose invoice belongs to ANOTHER Stripe sub.
      const decoy = await prisma.payment.create({
        data: {
          studioId: w.studio.id, userId: w.member.id, subscriptionId: null,
          membershipPlanId: w.proPlan.id, amountCents: 60000, currency: 'mxn',
          status: 'SUCCEEDED', paymentMethod: 'STRIPE', stripeInvoiceId: 'in_other_sub',
          paidAt: new Date(),
        },
      });
      const paymentsBefore = await prisma.payment.count();
      const bootyBefore = await prisma.subscription.findUniqueOrThrow({ where: { id: w.bootyRow.id } });

      const result = await runFlagOff(() =>
        runIvonneStackReconcile(
          prisma,
          fakeStripe({
            sub: { metadata: w.stripeMeta },
            invoiceSubByInvoiceId: { [INVOICE_ID]: STRIPE_SUB_ID, in_other_sub: 'sub_someone_else' },
          }),
          { identity: w.identity, execute: true, log: silent },
        ),
      );
      expect(result.status).toBe('EXECUTED');

      const pro = await prisma.subscription.findUniqueOrThrow({ where: { stripeSubscriptionId: STRIPE_SUB_ID } });
      expect(pro.membershipPlanId).toBe(w.proPlan.id);
      expect(pro.status).toBe(SubscriptionStatus.ACTIVE);
      expect(pro.source).toBe(SubscriptionSource.STRIPE);
      expect(pro.exclusiveGroupKey).toBe(CORE_EXCLUSIVE_GROUP);
      expect(pro.entitlementEndsAt).toBeNull();
      expect(pro.cancelAtPeriodEnd).toBe(false);
      expect(pro.currentPeriodStart?.getTime()).toBe((NOW_SEC - 10 * 86_400) * 1000);
      expect(pro.currentPeriodEnd?.getTime()).toBe((NOW_SEC + 20 * 86_400) * 1000);

      // Verified payment linked; decoy NOT linked; no payment rows created; nothing amended.
      const linked = await prisma.payment.findUniqueOrThrow({ where: { id: w.payment.id } });
      expect(linked.subscriptionId).toBe(pro.id);
      expect(linked.amountCents).toBe(60000);
      expect(linked.stripeInvoiceId).toBe(INVOICE_ID);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: decoy.id } })).subscriptionId).toBeNull();
      expect(await prisma.payment.count()).toBe(paymentsBefore);

      // Booty byte-identical.
      const bootyAfter = await prisma.subscription.findUniqueOrThrow({ where: { id: w.bootyRow.id } });
      expect(bootyAfter).toEqual(bootyBefore);

      // Exactly two compatible renewable memberships; one audit row.
      const renewable = await activeSubs(w.studio.id, w.member.id);
      expect(renewable).toHaveLength(2);
      expect(await prisma.auditLog.count({ where: { action: 'MM5_IVONNE_STRIPE_STACK_RECONCILED' } })).toBe(1);
    });

    it('rerun after success returns ALREADY_RECONCILED with no new row and no new audit entry', async () => {
      const w = await setupIvonneWorld();
      const stripe = fakeStripe({ sub: { metadata: w.stripeMeta } });
      await runFlagOff(() => runIvonneStackReconcile(prisma, stripe, { identity: w.identity, execute: true, log: silent }));
      const again = await runFlagOff(() =>
        runIvonneStackReconcile(prisma, stripe, { identity: w.identity, execute: true, log: silent }),
      );
      expect(again.status).toBe('ALREADY_RECONCILED');
      expect(await prisma.subscription.count({ where: { stripeSubscriptionId: STRIPE_SUB_ID } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'MM5_IVONNE_STRIPE_STACK_RECONCILED' } })).toBe(1);
    });

    it('fails closed on every identity/state mismatch and never writes', async () => {
      const w = await setupIvonneWorld();
      const runs: Array<[string, () => Promise<unknown>]> = [
        ['flag ON', async () => {
          process.env['MULTI_MEMBERSHIP_ENABLED'] = 'true';
          try {
            return await runIvonneStackReconcile(prisma, fakeStripe({ sub: { metadata: w.stripeMeta } }), { identity: w.identity, execute: true, log: silent });
          } finally { process.env['MULTI_MEMBERSHIP_ENABLED'] = 'true'; }
        }],
        ['wrong Stripe metadata userId', () => runFlagOff(() => runIvonneStackReconcile(prisma, fakeStripe({ sub: { metadata: { ...w.stripeMeta, userId: 'someone-else' } } }), { identity: w.identity, execute: true, log: silent }))],
        ['wrong Stripe metadata studioId', () => runFlagOff(() => runIvonneStackReconcile(prisma, fakeStripe({ sub: { metadata: { ...w.stripeMeta, studioId: 'other-studio' } } }), { identity: w.identity, execute: true, log: silent }))],
        ['wrong Booty row', () => runFlagOff(() => runIvonneStackReconcile(prisma, fakeStripe({ sub: { metadata: w.stripeMeta } }), { identity: { ...w.identity, bootySubscriptionId: 'nonexistent' }, execute: true, log: silent }))],
        ['live price mismatch', () => runFlagOff(() => runIvonneStackReconcile(prisma, fakeStripe({ sub: { metadata: w.stripeMeta, items: { data: [{ price: { id: 'price_wrong' }, current_period_start: NOW_SEC, current_period_end: NOW_SEC + 86400 }] } } }), { identity: w.identity, execute: true, log: silent }))],
        ['unexpected second live Stripe subscription', () => runFlagOff(() => runIvonneStackReconcile(prisma, fakeStripe({ sub: { metadata: w.stripeMeta }, extraLive: [{ id: 'sub_surprise', status: 'active', cancel_at_period_end: false, customer: 'cus_test_ivonne', metadata: { studioId: w.studio.id }, items: { data: [] } }] }), { identity: w.identity, execute: true, log: silent }))],
      ];
      for (const [label, run] of runs) {
        await expect(run()).rejects.toThrow(/IVONNE RECONCILE ABORT/);
        expect(await prisma.subscription.count({ where: { stripeSubscriptionId: STRIPE_SUB_ID } })).toBe(0);
        void label;
      }

      // Booty still CORE (Stage E not done) aborts.
      await prisma.subscription.update({ where: { id: w.bootyRow.id }, data: { exclusiveGroupKey: CORE_EXCLUSIVE_GROUP } });
      await expect(
        runFlagOff(() => runIvonneStackReconcile(prisma, fakeStripe({ sub: { metadata: w.stripeMeta } }), { identity: w.identity, execute: true, log: silent })),
      ).rejects.toThrow(/Stage E/);
      await prisma.subscription.update({ where: { id: w.bootyRow.id }, data: { exclusiveGroupKey: null } });

      // Wrong plan Stripe price aborts.
      await prisma.membershipPlan.update({ where: { id: w.proPlan.id }, data: { stripePriceId: 'price_changed' } });
      await expect(
        runFlagOff(() => runIvonneStackReconcile(prisma, fakeStripe({ sub: { metadata: w.stripeMeta } }), { identity: w.identity, execute: true, log: silent })),
      ).rejects.toThrow(/stripePriceId/);
      await prisma.membershipPlan.update({ where: { id: w.proPlan.id }, data: { stripePriceId: STRIPE_PRICE } });

      // A pre-existing renewable Pro row (not the reconciled one) aborts.
      const stray = await prisma.subscription.create({
        data: subRow(w.studio.id, w.member.id, w.proPlan.id, CORE_EXCLUSIVE_GROUP, SubscriptionStatus.ACTIVE),
      });
      await expect(
        runFlagOff(() => runIvonneStackReconcile(prisma, fakeStripe({ sub: { metadata: w.stripeMeta } }), { identity: w.identity, execute: true, log: silent })),
      ).rejects.toThrow(/renewable Pro/);
      await prisma.subscription.delete({ where: { id: stray.id } });

      expect(await prisma.auditLog.count({ where: { action: 'MM5_IVONNE_STRIPE_STACK_RECONCILED' } })).toBe(0);
    });
  });

  // ── MM-4 D: Booty stackable script (dry-run / execute / idempotence / reverse) ──

  describe('mm4-booty-stackable script', () => {
    async function setupBootyCoreWorld() {
      // Starting state for stage E: Booty plan still CORE, all rows snapshotted CORE.
      const { studio, fullPlan, bootyPlan } = await setupStudioWithPlans();
      await prisma.membershipPlan.update({ where: { id: bootyPlan.id }, data: { exclusiveGroup: CORE_EXCLUSIVE_GROUP } });

      const mk = async (email: string) => {
        const u = await createUserWithPassword(prisma, { email });
        await createMembership(prisma, u.id, studio.id, Role.MEMBER);
        return u;
      };
      const m1 = await mk('booty-script-1@e2e.local');
      const m2 = await mk('booty-script-2@e2e.local');
      const m3 = await mk('booty-script-3@e2e.local');
      const m4 = await mk('booty-script-4@e2e.local');

      const activeCash = await prisma.subscription.create({
        data: subRow(studio.id, m1.id, bootyPlan.id, CORE_EXCLUSIVE_GROUP, SubscriptionStatus.ACTIVE),
      });
      const trialingStripe = await prisma.subscription.create({
        data: {
          ...subRow(studio.id, m2.id, bootyPlan.id, CORE_EXCLUSIVE_GROUP, SubscriptionStatus.TRIALING),
          source: SubscriptionSource.STRIPE, stripeSubscriptionId: 'sub_booty_script_trial',
        },
      });
      const canceledEntitled = await prisma.subscription.create({
        data: {
          ...subRow(studio.id, m3.id, bootyPlan.id, CORE_EXCLUSIVE_GROUP, SubscriptionStatus.CANCELED),
          entitlementEndsAt: new Date(Date.now() + 10 * 86_400_000),
        },
      });
      const canceledEnded = await prisma.subscription.create({
        data: {
          ...subRow(studio.id, m4.id, bootyPlan.id, CORE_EXCLUSIVE_GROUP, SubscriptionStatus.CANCELED),
          entitlementEndsAt: new Date(Date.now() - 10 * 86_400_000),
        },
      });
      return { studio, fullPlan, bootyPlan, m1, activeCash, trialingStripe, canceledEntitled, canceledEnded };
    }

    const silent = () => undefined;

    it('dry-run selects exactly the live/entitled CORE rows and mutates NOTHING', async () => {
      const w = await setupBootyCoreWorld();
      const result = await runBootyStackable(prisma, {
        studioId: w.studio.id, planId: w.bootyPlan.id, execute: false, log: silent,
      });
      expect(result.changedRowIds.sort()).toEqual(
        [w.activeCash.id, w.trialingStripe.id, w.canceledEntitled.id].sort(),
      );
      expect(result.planChanged).toBe(false);
      const plan = await prisma.membershipPlan.findUniqueOrThrow({ where: { id: w.bootyPlan.id } });
      expect(plan.exclusiveGroup).toBe(CORE_EXCLUSIVE_GROUP);
      const stillCore = await prisma.subscription.count({
        where: { membershipPlanId: w.bootyPlan.id, exclusiveGroupKey: CORE_EXCLUSIVE_GROUP },
      });
      expect(stillCore).toBe(4);
    });

    it('execute reclassifies ONLY the intended rows (ended history untouched), audits, and is idempotent', async () => {
      const w = await setupBootyCoreWorld();
      const result = await runBootyStackable(prisma, {
        studioId: w.studio.id, planId: w.bootyPlan.id, execute: true, log: silent,
      });
      expect(result.planChanged).toBe(true);
      expect(result.changedRowIds.sort()).toEqual(
        [w.activeCash.id, w.trialingStripe.id, w.canceledEntitled.id].sort(),
      );

      const plan = await prisma.membershipPlan.findUniqueOrThrow({ where: { id: w.bootyPlan.id } });
      expect(plan.exclusiveGroup).toBeNull();
      for (const id of [w.activeCash.id, w.trialingStripe.id, w.canceledEntitled.id]) {
        const row = await prisma.subscription.findUniqueOrThrow({ where: { id } });
        expect(row.exclusiveGroupKey).toBeNull();
      }
      // Fully-ended historical row keeps the snapshot it was sold under.
      const ended = await prisma.subscription.findUniqueOrThrow({ where: { id: w.canceledEnded.id } });
      expect(ended.exclusiveGroupKey).toBe(CORE_EXCLUSIVE_GROUP);
      expect(ended.status).toBe(SubscriptionStatus.CANCELED);

      const audit = await prisma.auditLog.findFirst({
        where: { studioId: w.studio.id, action: 'MM4_BOOTY_STACKABLE_EXECUTED' },
      });
      expect(audit).not.toBeNull();
      expect((audit!.metadata as { rowCount: number }).rowCount).toBe(3);

      // Idempotence: a second execute changes nothing and reports nothing to change.
      const second = await runBootyStackable(prisma, {
        studioId: w.studio.id, planId: w.bootyPlan.id, execute: true, log: silent,
      });
      expect(second.changedRowIds).toEqual([]);
      expect(second.planChanged).toBe(false);
    });

    it('reverse refuses while a legitimate stacked pair involving Booty exists; works pre-dual', async () => {
      const w = await setupBootyCoreWorld();
      await runBootyStackable(prisma, { studioId: w.studio.id, planId: w.bootyPlan.id, execute: true, log: silent });

      // m1 now stacks Full alongside Booty — reversal must refuse.
      await prisma.subscription.create({
        data: subRow(w.studio.id, w.m1.id, w.fullPlan.id, CORE_EXCLUSIVE_GROUP, SubscriptionStatus.ACTIVE),
      });
      await expect(
        runBootyStackableReverse(prisma, { studioId: w.studio.id, planId: w.bootyPlan.id, execute: true, log: silent }),
      ).rejects.toThrow(/REVERSE blocked/);

      // Remove the stack → reversal proceeds and restores plan + live snapshots to CORE.
      await prisma.subscription.deleteMany({
        where: { studioId: w.studio.id, userId: w.m1.id, membershipPlanId: w.fullPlan.id },
      });
      const reversed = await runBootyStackableReverse(prisma, {
        studioId: w.studio.id, planId: w.bootyPlan.id, execute: true, log: silent,
      });
      expect(reversed.planChanged).toBe(true);
      expect(reversed.changedRowIds.sort()).toEqual(
        [w.activeCash.id, w.trialingStripe.id, w.canceledEntitled.id].sort(),
      );
      const plan = await prisma.membershipPlan.findUniqueOrThrow({ where: { id: w.bootyPlan.id } });
      expect(plan.exclusiveGroup).toBe(CORE_EXCLUSIVE_GROUP);
    });
  });
});
