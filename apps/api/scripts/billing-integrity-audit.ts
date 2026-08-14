/**
 * Stripe ↔ GymOS Billing Integrity Audit
 *
 * READ-ONLY script: queries production DB + Stripe to surface billing inconsistencies.
 * Does NOT modify Stripe, does NOT run DB writes, does NOT cancel or refund anything.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/billing-integrity-audit.ts [--studio <id>]
 *
 * Env required: DATABASE_URL, STRIPE_SECRET_KEY
 */

import Stripe from 'stripe';
import { Prisma, PrismaClient, SubscriptionStatus } from '@prisma/client';

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  typescript: true,
  apiVersion: '2025-08-27.basil',
});

const RENEWABLE_STATUSES = new Set<SubscriptionStatus>([
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.PAUSED,
]);

const RENEWABLE_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due', 'paused']);

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

type AuditIssue = {
  kind: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  studioId: string;
  userId: string;
  details: Record<string, unknown>;
};

type PlanDriftStatus =
  | 'PRICE_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'INTERVAL_MISMATCH'
  | 'INACTIVE_STRIPE_PRICE'
  | 'FETCH_ERROR';

type DeadLetterEntry = {
  stripeEventId: string;
  eventType: string;
  attemptCount: number;
  createdAt: Date;
  ageDays: number;
  resolvedAt: Date | null;
  resolutionNote: string | null;
};

type AuditReport = {
  runAt: string;
  totalMembersScanned: number;
  issues: AuditIssue[];
  /** Unresolved failures that require operator action. */
  actionableDeadLetters: DeadLetterEntry[];
  /** Historical failures where state was reconciled manually. Preserved for audit trail. */
  resolvedHistoricalDeadLetters: DeadLetterEntry[];
  priceDriftPlans: Array<{
    planId: string;
    planName: string;
    studioId: string;
    localPriceCents: number;
    localCurrency: string;
    localBillingInterval: string;
    stripePriceId: string;
    stripeUnitAmount: number | null;
    stripeCurrency: string | null;
    stripeInterval: string | null;
    stripeActive: boolean | null;
    driftStatus: PlanDriftStatus;
  }>;
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

async function listStripeSubsForCustomer(customerId: string): Promise<Stripe.Subscription[]> {
  const results: Stripe.Subscription[] = [];
  for await (const sub of stripe.subscriptions.list({ customer: customerId, limit: 100 })) {
    results.push(sub as Stripe.Subscription);
  }
  return results;
}

function isoNow() {
  return new Date().toISOString();
}

function ageDays(date: Date) {
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
}

// ──────────────────────────────────────────────────────────────────────────────
// Main audit
// ──────────────────────────────────────────────────────────────────────────────

async function run() {
  const studioFilter = process.argv.includes('--studio')
    ? process.argv[process.argv.indexOf('--studio') + 1]
    : undefined;

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  GYMOS BILLING INTEGRITY AUDIT');
  console.log(`  ${isoNow()}`);
  if (studioFilter) console.log(`  Studio filter: ${studioFilter}`);
  console.log(`${'═'.repeat(70)}\n`);

  const report: AuditReport = {
    runAt: isoNow(),
    totalMembersScanned: 0,
    issues: [],
    actionableDeadLetters: [],
    resolvedHistoricalDeadLetters: [],
    priceDriftPlans: [],
  };

  // ── 1. Dead-letter webhook events ──────────────────────────────────────────

  console.log('Scanning dead-letter webhook events...');
  const allDeadLetters = await prisma.stripeWebhookEvent.findMany({
    where: {
      processed: false,
      attemptCount: { gt: 0 },
      createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: 'asc' },
  });

  for (const dl of allDeadLetters) {
    const entry: DeadLetterEntry = {
      stripeEventId: dl.stripeEventId,
      eventType: dl.eventType,
      attemptCount: dl.attemptCount,
      createdAt: dl.createdAt,
      ageDays: ageDays(dl.createdAt),
      resolvedAt: dl.resolvedAt,
      resolutionNote: dl.resolutionNote,
    };
    if (dl.resolvedAt) {
      report.resolvedHistoricalDeadLetters.push(entry);
    } else {
      report.actionableDeadLetters.push(entry);
    }
  }

  console.log(
    `  Found ${allDeadLetters.length} dead-letter event(s): ` +
    `${report.actionableDeadLetters.length} actionable, ` +
    `${report.resolvedHistoricalDeadLetters.length} resolved historical\n`,
  );

  // ── 2. Membership plan price drift ────────────────────────────────────────

  console.log('Scanning membership plan price drift...');
  const plans = await prisma.membershipPlan.findMany({
    where: {
      active: true,
      deletedAt: null,
      stripePriceId: { not: null },
      ...(studioFilter ? { studioId: studioFilter } : {}),
    },
    select: { id: true, name: true, studioId: true, priceCents: true, stripePriceId: true, currency: true, billingInterval: true },
  });

  for (const plan of plans) {
    if (!plan.stripePriceId) continue;
    try {
      const price = await stripe.prices.retrieve(plan.stripePriceId);
      const stripeAmount = price.unit_amount;
      const stripeCurrency = price.currency ?? null;
      const stripeInterval = price.recurring?.interval ?? null;

      const localInterval = (() => {
        switch (plan.billingInterval) {
          case 'MONTHLY': return 'month';
          case 'YEARLY': return 'year';
          case 'WEEKLY': return 'week';
          default: return null;
        }
      })();

      let driftStatus: PlanDriftStatus | null = null;
      if (!price.active) {
        driftStatus = 'INACTIVE_STRIPE_PRICE';
      } else if (stripeAmount !== plan.priceCents) {
        driftStatus = 'PRICE_MISMATCH';
      } else if (stripeCurrency && stripeCurrency.toLowerCase() !== plan.currency.toLowerCase()) {
        driftStatus = 'CURRENCY_MISMATCH';
      } else if (stripeInterval && localInterval && stripeInterval !== localInterval) {
        driftStatus = 'INTERVAL_MISMATCH';
      }

      if (driftStatus) {
        report.priceDriftPlans.push({
          planId: plan.id,
          planName: plan.name,
          studioId: plan.studioId,
          localPriceCents: plan.priceCents,
          localCurrency: plan.currency,
          localBillingInterval: plan.billingInterval,
          stripePriceId: plan.stripePriceId,
          stripeUnitAmount: stripeAmount,
          stripeCurrency,
          stripeInterval,
          stripeActive: price.active,
          driftStatus,
        });
      }
    } catch {
      report.priceDriftPlans.push({
        planId: plan.id,
        planName: plan.name,
        studioId: plan.studioId,
        localPriceCents: plan.priceCents,
        localCurrency: plan.currency,
        localBillingInterval: plan.billingInterval,
        stripePriceId: plan.stripePriceId,
        stripeUnitAmount: null,
        stripeCurrency: null,
        stripeInterval: null,
        stripeActive: null,
        driftStatus: 'FETCH_ERROR',
      });
    }
  }

  console.log(`  Found ${report.priceDriftPlans.length} plan(s) with price drift\n`);

  // ── 3. Per-member subscription reconciliation ──────────────────────────────

  console.log('Scanning members with Stripe subscriptions...');

  const membersWithStripe = await prisma.user.findMany({
    where: {
      stripeCustomerId: { not: null },
      ...(studioFilter
        ? {
            studioMemberships: {
              some: { studioId: studioFilter, deletedAt: null },
            },
          }
        : {}),
      deletedAt: null,
    },
    select: {
      id: true,
      email: true,
      stripeCustomerId: true,
      subscriptions: {
        where: {
          status: { in: Array.from(RENEWABLE_STATUSES) },
          stripeSubscriptionId: { not: null },
        },
        include: { membershipPlan: { select: { id: true, name: true, priceCents: true } } },
      },
    },
  });

  report.totalMembersScanned = membersWithStripe.length;
  console.log(`  Scanning ${membersWithStripe.length} member(s)...\n`);

  for (const user of membersWithStripe) {
    if (!user.stripeCustomerId) continue;

    // Group local subs by studioId
    const localSubsByStudio = new Map<string, typeof user.subscriptions>();
    for (const sub of user.subscriptions) {
      const list = localSubsByStudio.get(sub.studioId) ?? [];
      list.push(sub);
      localSubsByStudio.set(sub.studioId, list);
    }

    // Fetch all Stripe subs for this customer (once, not per-studio).
    // Auto-paginates via SDK for await — handles customers with >100 subscriptions.
    let allStripeSubs: Stripe.Subscription[] = [];
    try {
      allStripeSubs = await listStripeSubsForCustomer(user.stripeCustomerId);
    } catch (err) {
      report.issues.push({
        kind: 'stripe_api_error',
        severity: 'WARNING',
        studioId: studioFilter ?? 'unknown',
        userId: user.id,
        details: { customerId: user.stripeCustomerId, error: String(err) },
      });
      continue;
    }

    // Determine which studios to inspect. We union studioIds from:
    //   1. Local subscription rows  — fast path for the normal case
    //   2. Stripe subscription metadata — catches Stripe orphans (active Stripe sub
    //      with no local row at all, as in Emilia's Full Access case)
    // A user with ALL webhooks permanently failed has no local rows but Stripe subs
    // remain discoverable via metadata.
    const studioIdSet = new Set<string>();
    if (studioFilter) {
      studioIdSet.add(studioFilter);
    } else {
      for (const sid of localSubsByStudio.keys()) studioIdSet.add(sid);
      for (const s of allStripeSubs) {
        const sid = s.metadata?.studioId;
        if (sid) studioIdSet.add(sid);
      }
    }
    const studioIds = Array.from(studioIdSet);

    // Check each studio the user has a presence in (local or Stripe)
    for (const studioId of studioIds) {
      const localSubs = localSubsByStudio.get(studioId) ?? [];
      const studioStripeSubs = allStripeSubs.filter(
        (s) => s.metadata?.studioId === studioId,
      );
      const renewableStripeSubs = studioStripeSubs.filter((s) =>
        RENEWABLE_STRIPE_STATUSES.has(s.status),
      );
      const localByStripeId = new Map(
        localSubs
          .filter((l) => l.stripeSubscriptionId)
          .map((l) => [l.stripeSubscriptionId!, l]),
      );
      const stripeById = new Map(studioStripeSubs.map((s) => [s.id, s]));

      // Detect duplicate renewable Stripe subs
      if (renewableStripeSubs.length > 1) {
        report.issues.push({
          kind: 'duplicate_renewable',
          severity: 'CRITICAL',
          studioId,
          userId: user.id,
          details: {
            email: user.email,
            customerId: user.stripeCustomerId,
            stripeSubscriptionIds: renewableStripeSubs.map((s) => s.id),
            statuses: renewableStripeSubs.map((s) => s.status),
          },
        });
      }

      // Detect Stripe orphans
      for (const stripeSub of renewableStripeSubs) {
        if (!localByStripeId.has(stripeSub.id)) {
          const priceId =
            typeof stripeSub.items.data[0]?.price === 'string'
              ? stripeSub.items.data[0].price
              : stripeSub.items.data[0]?.price?.id ?? 'unknown';
          report.issues.push({
            kind: 'stripe_orphan',
            severity: 'CRITICAL',
            studioId,
            userId: user.id,
            details: {
              email: user.email,
              customerId: user.stripeCustomerId,
              stripeSubscriptionId: stripeSub.id,
              stripeStatus: stripeSub.status,
              stripePriceId: priceId,
            },
          });
        }
      }

      // Detect local orphans
      for (const localSub of localSubs) {
        const stripeSub = localSub.stripeSubscriptionId
          ? stripeById.get(localSub.stripeSubscriptionId)
          : undefined;
        if (!stripeSub || !RENEWABLE_STRIPE_STATUSES.has(stripeSub.status)) {
          report.issues.push({
            kind: 'local_orphan',
            severity: 'WARNING',
            studioId,
            userId: user.id,
            details: {
              email: user.email,
              localSubscriptionId: localSub.id,
              localStatus: localSub.status,
              stripeSubscriptionId: localSub.stripeSubscriptionId,
              stripeStatus: stripeSub?.status ?? 'not_found',
            },
          });
        }
      }

      // Detect drift for paired subs
      for (const localSub of localSubs) {
        const stripeSub = localSub.stripeSubscriptionId
          ? stripeById.get(localSub.stripeSubscriptionId)
          : undefined;
        if (!stripeSub) continue;

        if (localSub.cancelAtPeriodEnd !== stripeSub.cancel_at_period_end) {
          report.issues.push({
            kind: 'cancel_at_period_end_drift',
            severity: 'WARNING',
            studioId,
            userId: user.id,
            details: {
              email: user.email,
              localSubscriptionId: localSub.id,
              localValue: localSub.cancelAtPeriodEnd,
              stripeValue: stripeSub.cancel_at_period_end,
            },
          });
        }
      }
    }
  }

  // ── 4. Duplicate local renewable subscriptions (DB-only check) ────────────

  console.log('Scanning for duplicate local renewable subscriptions...');
  const studioClause = studioFilter
    ? Prisma.sql`AND studio_id = ${studioFilter}`
    : Prisma.empty;

  const dupRows = await prisma.$queryRaw<Array<{ studio_id: string; user_id: string; cnt: bigint }>>`
    SELECT studio_id, user_id, COUNT(*) AS cnt
    FROM subscriptions
    WHERE status = ANY(ARRAY['ACTIVE','TRIALING','PAST_DUE','PAUSED']::"SubscriptionStatus"[])
      AND stripe_subscription_id IS NOT NULL
      ${studioClause}
    GROUP BY studio_id, user_id
    HAVING COUNT(*) > 1
  `;

  for (const row of dupRows) {
    report.issues.push({
      kind: 'duplicate_local_renewable',
      severity: 'CRITICAL',
      studioId: row.studio_id,
      userId: row.user_id,
      details: { localRenewableCount: Number(row.cnt) },
    });
  }

  console.log(`  Found ${dupRows.length} member(s) with duplicate local renewable subscriptions\n`);

  // ── Output ─────────────────────────────────────────────────────────────────

  console.log(`${'═'.repeat(70)}`);
  console.log('  AUDIT RESULTS');
  console.log(`${'═'.repeat(70)}\n`);

  console.log(`Members scanned:                   ${report.totalMembersScanned}`);
  console.log(`Webhook health`);
  console.log(`  Actionable failures:             ${report.actionableDeadLetters.length}`);
  console.log(`  Resolved historical failures:    ${report.resolvedHistoricalDeadLetters.length}`);
  console.log(`Plan price mismatches:             ${report.priceDriftPlans.length}`);
  console.log(
    `Billing issues:                    ${report.issues.length} (` +
      `${report.issues.filter((i) => i.severity === 'CRITICAL').length} critical, ` +
      `${report.issues.filter((i) => i.severity === 'WARNING').length} warning)\n`,
  );

  if (report.actionableDeadLetters.length > 0) {
    console.log('── ACTIONABLE DEAD-LETTER WEBHOOKS (requires operator action) ──');
    for (const dl of report.actionableDeadLetters) {
      console.log(
        `  [${dl.ageDays}d old] ${dl.stripeEventId}  type=${dl.eventType}  attempts=${dl.attemptCount}`,
      );
    }
    console.log();
  }

  if (report.resolvedHistoricalDeadLetters.length > 0) {
    console.log('── RESOLVED HISTORICAL WEBHOOK FAILURES (audit trail) ──');
    for (const dl of report.resolvedHistoricalDeadLetters) {
      console.log(
        `  [resolved ${dl.resolvedAt?.toISOString().slice(0, 10)}] ${dl.stripeEventId}  type=${dl.eventType}`,
      );
      if (dl.resolutionNote) {
        console.log(`    ${dl.resolutionNote.slice(0, 100)}...`);
      }
    }
    console.log();
  }

  if (report.priceDriftPlans.length > 0) {
    console.log('── PLAN PRICE DRIFT ──');
    for (const p of report.priceDriftPlans) {
      const localAmt = (p.localPriceCents / 100).toFixed(2);
      const stripeAmt = p.stripeUnitAmount != null ? (p.stripeUnitAmount / 100).toFixed(2) : '?';
      console.log(`  [${p.driftStatus}] ${p.planName} (${p.planId})`);
      console.log(`    studio=${p.studioId}  price_id=${p.stripePriceId}`);
      if (p.driftStatus === 'PRICE_MISMATCH') {
        console.log(`    amount: local=${p.localCurrency.toUpperCase()} ${localAmt}  stripe=${(p.stripeCurrency ?? p.localCurrency).toUpperCase()} ${stripeAmt}`);
      }
      if (p.driftStatus === 'CURRENCY_MISMATCH') {
        console.log(`    currency: local=${p.localCurrency}  stripe=${p.stripeCurrency}`);
      }
      if (p.driftStatus === 'INTERVAL_MISMATCH') {
        console.log(`    interval: local=${p.localBillingInterval}  stripe=${p.stripeInterval}`);
      }
    }
    console.log();
  }

  if (report.issues.length > 0) {
    console.log('── BILLING ISSUES ──');
    for (const issue of report.issues) {
      const prefix = issue.severity === 'CRITICAL' ? '🔴' : '⚠️ ';
      console.log(`${prefix} [${issue.kind}] studio=${issue.studioId} user=${issue.userId}`);
      console.log('   ' + JSON.stringify(issue.details, null, 2).replace(/\n/g, '\n   '));
    }
    console.log();
  }

  if (
    report.issues.length === 0 &&
    report.actionableDeadLetters.length === 0 &&
    report.priceDriftPlans.length === 0
  ) {
    console.log('✅ No actionable billing integrity issues found.');
    if (report.resolvedHistoricalDeadLetters.length > 0) {
      console.log(`   (${report.resolvedHistoricalDeadLetters.length} historical resolved failures on record)`);
    }
  }

  // Exit non-zero when actionable issues exist (enables Railway cron alerting)
  const hasActionable =
    report.issues.filter((i) => i.severity === 'CRITICAL').length > 0 ||
    report.actionableDeadLetters.length > 0;
  if (hasActionable) {
    process.exitCode = 1;
  }

  console.log(`\n${'═'.repeat(70)}\n`);

  await prisma.$disconnect();
}

run().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
