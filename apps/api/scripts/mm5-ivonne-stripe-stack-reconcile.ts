/**
 * MM-5 Stage 5b — IVONNE LEGACY STRIPE STACK RECONCILIATION (one-time, gated).
 *
 * Business truth: Ivonne intentionally owns BOTH memberships — her existing CASH
 * Booty Lab subscription AND her live Stripe "Pro" subscription (the founding customer
 * case for multi-membership). The legacy one-membership webhook acknowledged her Stripe
 * purchase without creating a local row, leaving a paid Stripe subscription with no
 * GymOS access. This script attaches the EXISTING Stripe contract locally:
 *
 *   - creates exactly ONE local Pro subscription row mirroring live Stripe truth
 *     (status, period, cancelAtPeriodEnd), snapshot exclusiveGroupKey = 'CORE'
 *   - links her EXISTING SUCCEEDED Stripe payment rows (created by invoice.paid via
 *     customer resolution with subscriptionId NULL) to the new row — after verifying
 *     each payment's invoice belongs to this exact Stripe subscription. It NEVER
 *     creates, amends, or duplicates a financial event.
 *   - writes one AuditLog row.
 *
 * It never cancels, refunds, supersedes, replaces, combines, or re-charges anything,
 * and performs ONLY GET calls against Stripe. Both contracts remain independently
 * billed and independently manageable.
 *
 * Runs ONLY after the constraint swap + Booty reclassification (its preconditions
 * fail closed otherwise) and BEFORE MULTI_MEMBERSHIP_ENABLED is turned on — this is
 * reconciliation of an EXISTING contract under the always-on family semantics, not
 * creation of a new stack, so the creation gate is deliberately (and auditably) not
 * consulted. Family compatibility is still asserted via the canonical module.
 *
 * Usage (DRY RUN is the default; nothing is written without --execute):
 *   npx tsx scripts/mm5-ivonne-stripe-stack-reconcile.ts
 *   npx tsx scripts/mm5-ivonne-stripe-stack-reconcile.ts --execute
 *
 * The CLI operates exclusively on the hardcoded production identities below and
 * accepts no identity arguments.
 */
import { PrismaClient, Prisma, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import type Stripe from 'stripe';
import { acquireSubscriptionWriteAdvisoryLock } from '../src/billing/subscription-write-advisory-lock';
import { mapStripeSubscriptionStatus } from '../src/billing/stripe-subscription-status';
import { readStripeInvoiceSubscriptionId } from '../src/billing/stripe-invoice.utils';
import { RENEWABLE_SUBSCRIPTION_STATUSES } from '../src/billing/subscription-lifecycle.constants';
import { findConflictingMemberships } from '../src/memberships/membership-compatibility';

export type IvonneReconcileIdentity = {
  studioId: string;
  userId: string;
  bootySubscriptionId: string;
  proPlanId: string;
  stripeSubscriptionId: string;
  expectedStripePriceId: string;
};

/** Exact known production identities — the CLI refuses to operate on anything else. */
export const IVONNE_IDENTITY: IvonneReconcileIdentity = {
  studioId: 'cmp33m0gp0000qomlj9p42ia5',
  userId: 'cmsyxt2vh0015rr1y9wse2mh8',
  bootySubscriptionId: 'cmszbm3on0053rr1y7birwbvx',
  proPlanId: 'cmqzn1r95003zqo0rh16v6nbf',
  stripeSubscriptionId: 'sub_1U8iKnGuUoCXNOREVnsNhHEc',
  expectedStripePriceId: 'price_1TnlX3GuUoCXNOREl0WbiOsR',
};

/** Minimal structural shape of the Stripe objects this script reads (GET-only). */
export type StripeSubscriptionLike = {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  customer: string | { id: string };
  metadata: Record<string, string | undefined>;
  items: {
    data: Array<{
      price?: { id?: string } | string | null;
      current_period_start?: number | null;
      current_period_end?: number | null;
    }>;
  };
};

export type StripeReadClient = {
  subscriptions: {
    retrieve(id: string): Promise<StripeSubscriptionLike>;
    list(params: { customer: string; status: string; limit: number }): Promise<{ data: StripeSubscriptionLike[] }>;
  };
  invoices: {
    retrieve(id: string): Promise<unknown>;
  };
};

export type IvonneReconcileResult = {
  status: 'DRY_RUN' | 'EXECUTED' | 'ALREADY_RECONCILED';
  proSubscriptionId: string | null;
  linkedPaymentIds: string[];
};

const RENEWABLE_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due', 'paused']);

function fail(reason: string): never {
  throw new Error(`IVONNE RECONCILE ABORT: ${reason}`);
}

function periodDate(value: number | null | undefined, field: string): Date {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`live Stripe subscription has no usable ${field} — refusing to invent period dates`);
  }
  return new Date(value * 1000);
}

function priceIdOf(sub: StripeSubscriptionLike): string | null {
  const price = sub.items.data[0]?.price;
  if (typeof price === 'string') return price;
  return price?.id ?? null;
}

export async function runIvonneStackReconcile(
  prisma: PrismaClient,
  stripe: StripeReadClient,
  options: { execute?: boolean; log?: (line: string) => void; identity?: IvonneReconcileIdentity } = {},
): Promise<IvonneReconcileResult> {
  const id = options.identity ?? IVONNE_IDENTITY;
  const execute = options.execute ?? false;
  const log = options.log ?? ((line: string) => console.log(line));

  log(`MM-5 Stage 5b — Ivonne stack reconciliation (${execute ? 'EXECUTE' : 'DRY RUN'})`);

  // ── Preconditions (fail closed) ─────────────────────────────────────────────

  if (process.env['MULTI_MEMBERSHIP_ENABLED'] === 'true') {
    fail('MULTI_MEMBERSHIP_ENABLED is true — this repair is designed to run before general enablement');
  }

  const migrations = (await prisma.$queryRawUnsafe(
    `SELECT migration_name FROM _prisma_migrations WHERE migration_name IN
       ('20260908120000_multi_membership_additive_foundation','20260908220000_multi_membership_constraint_swap')`,
  )) as Array<{ migration_name: string }>;
  if (migrations.length !== 2) {
    fail(`both MM migrations must be applied (found ${migrations.length}/2)`);
  }

  const indexes = (await prisma.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE tablename='subscriptions' AND indexname LIKE '%one\\_%'`,
  )) as Array<{ indexname: string }>;
  const idxNames = new Set(indexes.map((r) => r.indexname));
  const finalIdx = [
    'subscriptions_one_renewable_per_member_plan_idx',
    'subscriptions_one_renewable_per_member_group_idx',
    'subscriptions_one_scheduled_per_member_plan_idx',
    'subscriptions_one_scheduled_per_member_group_idx',
  ];
  for (const name of finalIdx) {
    if (!idxNames.has(name)) fail(`final MM index missing: ${name} — constraint swap not complete`);
  }
  if (
    idxNames.has('subscriptions_one_active_per_user_per_studio_idx') ||
    idxNames.has('subscriptions_one_scheduled_per_user_per_studio_idx')
  ) {
    fail('legacy member-scoped indexes still present — constraint swap not complete');
  }

  const bootyRow = await prisma.subscription.findUnique({
    where: { id: id.bootySubscriptionId },
    include: { membershipPlan: { select: { id: true, name: true, exclusiveGroup: true } } },
  });
  if (!bootyRow) fail(`Booty subscription ${id.bootySubscriptionId} not found`);
  if (bootyRow.studioId !== id.studioId || bootyRow.userId !== id.userId) {
    fail('Booty subscription does not belong to the expected studio/user');
  }
  if (bootyRow.source !== SubscriptionSource.CASH) fail('Booty subscription is not CASH');
  if (bootyRow.exclusiveGroupKey !== null) {
    fail(`Booty snapshot is ${JSON.stringify(bootyRow.exclusiveGroupKey)} — Stage E (Booty reclassification) not complete`);
  }
  if (bootyRow.membershipPlan.exclusiveGroup !== null) {
    fail('Booty plan exclusiveGroup is not NULL — Stage E not complete');
  }
  // Before-image for the untouched-Booty postcondition.
  const bootyBefore = {
    status: bootyRow.status,
    currentPeriodStart: bootyRow.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: bootyRow.currentPeriodEnd?.toISOString() ?? null,
    entitlementEndsAt: bootyRow.entitlementEndsAt?.toISOString() ?? null,
    exclusiveGroupKey: bootyRow.exclusiveGroupKey,
  };

  const proPlan = await prisma.membershipPlan.findFirst({
    where: { id: id.proPlanId, studioId: id.studioId, deletedAt: null },
    select: { id: true, name: true, active: true, stripePriceId: true, exclusiveGroup: true, entitlementDays: true },
  });
  if (!proPlan) fail(`Pro plan ${id.proPlanId} not found`);
  if (!proPlan.active) fail('Pro plan is not active');
  if (proPlan.stripePriceId !== id.expectedStripePriceId) {
    fail(`Pro plan stripePriceId ${proPlan.stripePriceId} does not match expected ${id.expectedStripePriceId}`);
  }
  if (proPlan.entitlementDays !== null) fail('Pro plan unexpectedly has entitlementDays — no cycles are created here');
  if (proPlan.exclusiveGroup !== 'CORE') fail(`Pro plan exclusiveGroup is ${JSON.stringify(proPlan.exclusiveGroup)}, expected 'CORE'`);

  // ── Live Stripe truth (GET-only) ────────────────────────────────────────────

  const liveSub = await stripe.subscriptions.retrieve(id.stripeSubscriptionId);
  if (liveSub.metadata?.userId !== id.userId) fail('live Stripe metadata userId mismatch');
  if (liveSub.metadata?.studioId !== id.studioId) fail('live Stripe metadata studioId mismatch');
  if (liveSub.metadata?.planId !== id.proPlanId) fail('live Stripe metadata planId mismatch');
  if (priceIdOf(liveSub) !== id.expectedStripePriceId) fail('live Stripe price mismatch');
  if (!RENEWABLE_STRIPE_STATUSES.has(liveSub.status)) {
    fail(`live Stripe status '${liveSub.status}' is not a supported renewable state`);
  }
  const mappedStatus = mapStripeSubscriptionStatus(liveSub.status);
  const currentPeriodStart = periodDate(liveSub.items.data[0]?.current_period_start, 'current_period_start');
  const currentPeriodEnd = periodDate(liveSub.items.data[0]?.current_period_end, 'current_period_end');
  const customerId = typeof liveSub.customer === 'string' ? liveSub.customer : liveSub.customer.id;

  // No other unexpected live Stripe subscription for this member.
  const allLive = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  const otherLive = allLive.data.filter(
    (s) =>
      s.id !== id.stripeSubscriptionId &&
      RENEWABLE_STRIPE_STATUSES.has(s.status) &&
      (s.metadata?.studioId === undefined || s.metadata.studioId === id.studioId),
  );
  if (otherLive.length > 0) {
    fail(`unexpected additional live Stripe subscription(s): ${otherLive.map((s) => s.id).join(', ')}`);
  }

  // ── Local row state / idempotency ───────────────────────────────────────────

  const existingByStripeId = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: id.stripeSubscriptionId },
  });
  if (existingByStripeId) {
    if (
      existingByStripeId.studioId === id.studioId &&
      existingByStripeId.userId === id.userId &&
      existingByStripeId.membershipPlanId === id.proPlanId &&
      existingByStripeId.exclusiveGroupKey === 'CORE'
    ) {
      log(`ALREADY_RECONCILED — local Pro subscription ${existingByStripeId.id} already carries ${id.stripeSubscriptionId}`);
      await verifyPostConditions(prisma, id, existingByStripeId.id, bootyBefore, log);
      return { status: 'ALREADY_RECONCILED', proSubscriptionId: existingByStripeId.id, linkedPaymentIds: [] };
    }
    fail(`a local subscription (${existingByStripeId.id}) already uses ${id.stripeSubscriptionId} but does not match the expected identity`);
  }

  const renewableRows = await prisma.subscription.findMany({
    where: { studioId: id.studioId, userId: id.userId, status: { in: RENEWABLE_SUBSCRIPTION_STATUSES } },
    select: { id: true, membershipPlanId: true, exclusiveGroupKey: true, status: true },
  });
  if (renewableRows.some((r) => r.membershipPlanId === id.proPlanId)) {
    fail('a renewable Pro subscription already exists locally and is not the reconciled row');
  }
  const conflicts = findConflictingMemberships(
    renewableRows.map((r) => ({ membershipPlanId: r.membershipPlanId, exclusiveGroupKey: r.exclusiveGroupKey })),
    { id: proPlan.id, exclusiveGroup: proPlan.exclusiveGroup },
  );
  if (conflicts.length > 0) {
    fail('an incompatible renewable membership (same plan or same CORE family) exists — cannot attach Pro');
  }

  // ── Payments to link: verified per-invoice against the exact Stripe subscription ──

  const candidatePayments = await prisma.payment.findMany({
    where: {
      studioId: id.studioId,
      userId: id.userId,
      membershipPlanId: id.proPlanId,
      paymentMethod: 'STRIPE',
      status: 'SUCCEEDED',
      subscriptionId: null,
      stripeInvoiceId: { not: null },
    },
    select: { id: true, stripeInvoiceId: true, amountCents: true, paidAt: true },
    orderBy: { paidAt: 'asc' },
  });
  const verifiedPayments: typeof candidatePayments = [];
  for (const payment of candidatePayments) {
    const invoice = await stripe.invoices.retrieve(payment.stripeInvoiceId!);
    const invoiceSubId = readStripeInvoiceSubscriptionId(invoice as Stripe.Invoice);
    if (invoiceSubId === id.stripeSubscriptionId) {
      verifiedPayments.push(payment);
    } else {
      log(`  payment ${payment.id} (invoice ${payment.stripeInvoiceId}) belongs to ${invoiceSubId ?? 'no subscription'} — NOT linked`);
    }
  }

  // ── Plan / report ───────────────────────────────────────────────────────────

  log(`plan: create ONE local Pro subscription mirroring live Stripe truth:`);
  log(`  studio=${id.studioId} user=${id.userId} plan=${id.proPlanId} (${proPlan.name})`);
  log(`  stripeSubscriptionId=${id.stripeSubscriptionId} status=${mappedStatus} cancelAtPeriodEnd=${liveSub.cancel_at_period_end}`);
  log(`  period ${currentPeriodStart.toISOString()} → ${currentPeriodEnd.toISOString()} · exclusiveGroupKey='CORE' · entitlementEndsAt=null`);
  log(`plan: link ${verifiedPayments.length} existing SUCCEEDED Stripe payment(s): ${verifiedPayments.map((x) => x.id).join(', ') || '(none)'}`);
  log(`plan: Booty row ${id.bootySubscriptionId} untouched (status=${bootyBefore.status}, snapshot=null)`);

  if (!execute) {
    log('DRY RUN — nothing written.');
    return { status: 'DRY_RUN', proSubscriptionId: null, linkedPaymentIds: verifiedPayments.map((x) => x.id) };
  }

  // ── Execute: one transaction, canonical member write lock first ─────────────

  const created = await prisma.$transaction(async (tx) => {
    await acquireSubscriptionWriteAdvisoryLock(tx, id.studioId, id.userId);

    // Re-assert the mutable local preconditions under the lock.
    const stillNone = await tx.subscription.findUnique({ where: { stripeSubscriptionId: id.stripeSubscriptionId }, select: { id: true } });
    if (stillNone) fail('raced: a local row for this Stripe subscription appeared');
    const bootyNow = await tx.subscription.findUnique({
      where: { id: id.bootySubscriptionId },
      select: { exclusiveGroupKey: true, studioId: true, userId: true },
    });
    if (!bootyNow || bootyNow.exclusiveGroupKey !== null || bootyNow.studioId !== id.studioId || bootyNow.userId !== id.userId) {
      fail('raced: Booty row state changed under the lock');
    }
    const renewableProNow = await tx.subscription.count({
      where: { studioId: id.studioId, userId: id.userId, membershipPlanId: id.proPlanId, status: { in: RENEWABLE_SUBSCRIPTION_STATUSES } },
    });
    if (renewableProNow > 0) fail('raced: a renewable Pro row appeared');

    const row = await tx.subscription.create({
      data: {
        studioId: id.studioId,
        userId: id.userId,
        membershipPlanId: id.proPlanId,
        status: mappedStatus,
        source: SubscriptionSource.STRIPE,
        stripeSubscriptionId: id.stripeSubscriptionId,
        exclusiveGroupKey: 'CORE',
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: liveSub.cancel_at_period_end,
        // entitlementEndsAt deliberately null — Pro is not a fixed-duration product.
      },
    });

    let linkedCount = 0;
    if (verifiedPayments.length > 0) {
      const linked = await tx.payment.updateMany({
        where: { id: { in: verifiedPayments.map((x) => x.id) }, subscriptionId: null },
        data: { subscriptionId: row.id },
      });
      linkedCount = linked.count;
    }

    await tx.auditLog.create({
      data: {
        studioId: id.studioId,
        actorUserId: null,
        action: 'MM5_IVONNE_STRIPE_STACK_RECONCILED',
        targetUserId: id.userId,
        entityType: 'Subscription',
        entityId: row.id,
        metadata: {
          stripeSubscriptionId: id.stripeSubscriptionId,
          liveStripeStatus: liveSub.status,
          mappedStatus,
          currentPeriodStart: currentPeriodStart.toISOString(),
          currentPeriodEnd: currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: liveSub.cancel_at_period_end,
          exclusiveGroupKey: 'CORE',
          bootySubscriptionId: id.bootySubscriptionId,
          linkedPaymentIds: verifiedPayments.map((x) => x.id),
          linkedPaymentCount: linkedCount,
          executedVia: 'scripts/mm5-ivonne-stripe-stack-reconcile.ts',
        } as Prisma.InputJsonValue,
      },
    });

    return { row, linkedCount };
  });

  log(`EXECUTED — created Pro subscription ${created.row.id}, linked ${created.linkedCount} payment(s).`);
  await verifyPostConditions(prisma, id, created.row.id, bootyBefore, log);
  return {
    status: 'EXECUTED',
    proSubscriptionId: created.row.id,
    linkedPaymentIds: verifiedPayments.map((x) => x.id),
  };
}

async function verifyPostConditions(
  prisma: PrismaClient,
  id: IvonneReconcileIdentity,
  proSubscriptionId: string,
  bootyBefore: { status: SubscriptionStatus; currentPeriodStart: string | null; currentPeriodEnd: string | null; entitlementEndsAt: string | null; exclusiveGroupKey: string | null },
  log: (line: string) => void,
): Promise<void> {
  const renewable = await prisma.subscription.findMany({
    where: { studioId: id.studioId, userId: id.userId, status: { in: RENEWABLE_SUBSCRIPTION_STATUSES } },
    select: { id: true, membershipPlanId: true, exclusiveGroupKey: true, source: true },
  });
  const pro = renewable.find((r) => r.id === proSubscriptionId);
  const booty = renewable.find((r) => r.id === id.bootySubscriptionId);
  if (!pro || pro.exclusiveGroupKey !== 'CORE' || pro.source !== SubscriptionSource.STRIPE) {
    fail('postcondition: reconciled Pro row missing or mis-shaped');
  }

  const dupPlan = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM subscriptions WHERE studio_id='${id.studioId}' AND user_id='${id.userId}'
      AND status IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED') GROUP BY membership_plan_id HAVING COUNT(*)>1) d`,
  )) as Array<{ n: number }>;
  const dupGroup = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM subscriptions WHERE studio_id='${id.studioId}' AND user_id='${id.userId}'
      AND status IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED') AND exclusive_group_key IS NOT NULL GROUP BY exclusive_group_key HAVING COUNT(*)>1) d`,
  )) as Array<{ n: number }>;
  const dupScheduled = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM subscriptions WHERE studio_id='${id.studioId}' AND user_id='${id.userId}'
      AND status='SCHEDULED' GROUP BY membership_plan_id HAVING COUNT(*)>1) d`,
  )) as Array<{ n: number }>;
  if ((dupPlan[0]?.n ?? 0) > 0 || (dupGroup[0]?.n ?? 0) > 0 || (dupScheduled[0]?.n ?? 0) > 0) {
    fail('postcondition: duplicate renewable/scheduled rows detected');
  }

  const bootyAfterRow = await prisma.subscription.findUnique({ where: { id: id.bootySubscriptionId } });
  const bootyAfter = {
    status: bootyAfterRow?.status,
    currentPeriodStart: bootyAfterRow?.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: bootyAfterRow?.currentPeriodEnd?.toISOString() ?? null,
    entitlementEndsAt: bootyAfterRow?.entitlementEndsAt?.toISOString() ?? null,
    exclusiveGroupKey: bootyAfterRow?.exclusiveGroupKey ?? null,
  };
  if (JSON.stringify(bootyAfter) !== JSON.stringify(bootyBefore)) {
    fail('postcondition: Booty row changed — it must be untouched');
  }

  const unlinked = await prisma.payment.count({
    where: {
      studioId: id.studioId,
      userId: id.userId,
      membershipPlanId: id.proPlanId,
      paymentMethod: 'STRIPE',
      status: 'SUCCEEDED',
      subscriptionId: null,
      stripeInvoiceId: { not: null },
    },
  });

  log(
    `verification: renewable memberships=${renewable.length} (pro=${pro.id}, booty=${booty ? booty.id : 'not-renewable(status-lapsed ok)'}) · ` +
      `dupPlan=0 dupGroup=0 dupScheduled=0 · unlinked candidate Pro payments remaining=${unlinked}`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const unknown = args.filter((a) => !['--execute', '--dry-run'].includes(a));
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(' ')} — this CLI accepts no identity overrides`);
  }
  const { default: StripeCtor } = await import('stripe');
  const key = process.env['STRIPE_SECRET_KEY'];
  if (!key) throw new Error('STRIPE_SECRET_KEY is required');
  const stripe = new StripeCtor(key) as unknown as StripeReadClient;
  const prisma = new PrismaClient();
  try {
    await runIvonneStackReconcile(prisma, stripe, { execute });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
