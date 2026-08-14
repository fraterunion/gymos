/**
 * READ-ONLY production audit — membership plan pricing integrity.
 *
 * Compares each active GymOS membership plan against its Stripe price, reporting
 * field-level drift (unit_amount, currency, billing interval) and an overall
 * status for every plan.
 *
 * DOES NOT: create, update, or archive any Stripe object.
 * DOES NOT: write to or modify the database.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/audit-plan-pricing.ts [--studio <id>]
 *
 * Env required: DATABASE_URL, STRIPE_SECRET_KEY
 */

import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  typescript: true,
  apiVersion: '2025-08-27.basil',
});

type PlanStatus =
  | 'HEALTHY'
  | 'PRICE_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'INTERVAL_MISMATCH'
  | 'MISSING_STRIPE_PRICE'
  | 'INACTIVE_STRIPE_PRICE'
  | 'OTHER_DRIFT'
  | 'FETCH_ERROR';

type PlanAuditRow = {
  planId: string;
  planName: string;
  studioId: string;
  stripePriceId: string | null;
  // Local values
  localPriceCents: number;
  localCurrency: string;
  localBillingInterval: string;
  // Stripe values (null when stripePriceId is missing or fetch failed)
  stripeUnitAmount: number | null;
  stripeCurrency: string | null;
  stripeInterval: string | null;
  stripeActive: boolean | null;
  // Field-level comparison
  amountMatches: boolean | null;
  currencyMatches: boolean | null;
  billingIntervalMatches: boolean | null;
  // Overall status
  status: PlanStatus;
};

function localIntervalToStripe(interval: string): string {
  switch (interval) {
    case 'MONTHLY': return 'month';
    case 'YEARLY': return 'year';
    case 'WEEKLY': return 'week';
    default: return interval.toLowerCase();
  }
}

function fmtCents(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function statusLabel(status: PlanStatus): string {
  const map: Record<PlanStatus, string> = {
    HEALTHY: '✅ HEALTHY',
    PRICE_MISMATCH: '🔴 PRICE_MISMATCH',
    CURRENCY_MISMATCH: '🔴 CURRENCY_MISMATCH',
    INTERVAL_MISMATCH: '🔴 INTERVAL_MISMATCH',
    MISSING_STRIPE_PRICE: '⚠️  MISSING_STRIPE_PRICE',
    INACTIVE_STRIPE_PRICE: '⚠️  INACTIVE_STRIPE_PRICE',
    OTHER_DRIFT: '🔴 OTHER_DRIFT',
    FETCH_ERROR: '❌ FETCH_ERROR',
  };
  return map[status];
}

async function auditPlan(plan: {
  id: string;
  name: string;
  studioId: string;
  priceCents: number;
  currency: string;
  billingInterval: string;
  stripePriceId: string | null;
}): Promise<PlanAuditRow> {
  const base = {
    planId: plan.id,
    planName: plan.name,
    studioId: plan.studioId,
    stripePriceId: plan.stripePriceId,
    localPriceCents: plan.priceCents,
    localCurrency: plan.currency,
    localBillingInterval: plan.billingInterval,
  };

  if (!plan.stripePriceId) {
    return {
      ...base,
      stripeUnitAmount: null,
      stripeCurrency: null,
      stripeInterval: null,
      stripeActive: null,
      amountMatches: null,
      currencyMatches: null,
      billingIntervalMatches: null,
      status: 'MISSING_STRIPE_PRICE',
    };
  }

  try {
    const price = await stripe.prices.retrieve(plan.stripePriceId);

    const stripeUnitAmount = price.unit_amount;
    const stripeCurrency = price.currency ?? null;
    const stripeInterval = price.recurring?.interval ?? null;
    const stripeActive = price.active;

    const amountMatches = stripeUnitAmount === plan.priceCents;
    const currencyMatches =
      stripeCurrency != null &&
      stripeCurrency.toLowerCase() === plan.currency.toLowerCase();
    const billingIntervalMatches =
      stripeInterval != null &&
      stripeInterval === localIntervalToStripe(plan.billingInterval);

    let status: PlanStatus;
    if (!stripeActive) {
      status = 'INACTIVE_STRIPE_PRICE';
    } else if (!amountMatches) {
      status = 'PRICE_MISMATCH';
    } else if (!currencyMatches) {
      status = 'CURRENCY_MISMATCH';
    } else if (!billingIntervalMatches) {
      status = 'INTERVAL_MISMATCH';
    } else {
      status = 'HEALTHY';
    }

    return {
      ...base,
      stripeUnitAmount,
      stripeCurrency,
      stripeInterval,
      stripeActive,
      amountMatches,
      currencyMatches,
      billingIntervalMatches,
      status,
    };
  } catch (err) {
    return {
      ...base,
      stripeUnitAmount: null,
      stripeCurrency: null,
      stripeInterval: null,
      stripeActive: null,
      amountMatches: null,
      currencyMatches: null,
      billingIntervalMatches: null,
      status: 'FETCH_ERROR',
    };
  }
}

async function run() {
  const studioFilter = process.argv.includes('--studio')
    ? process.argv[process.argv.indexOf('--studio') + 1]
    : undefined;

  const divider = '═'.repeat(80);
  console.log(`\n${divider}`);
  console.log('  MEMBERSHIP PLAN PRICING INTEGRITY AUDIT');
  console.log(`  ${new Date().toISOString()}`);
  if (studioFilter) console.log(`  Studio filter: ${studioFilter}`);
  console.log(`  READ-ONLY — no Stripe or DB writes`);
  console.log(`${divider}\n`);

  const plans = await prisma.membershipPlan.findMany({
    where: {
      active: true,
      deletedAt: null,
      ...(studioFilter ? { studioId: studioFilter } : {}),
    },
    select: {
      id: true,
      name: true,
      studioId: true,
      priceCents: true,
      currency: true,
      billingInterval: true,
      stripePriceId: true,
      active: true,
    },
    orderBy: [{ studioId: 'asc' }, { createdAt: 'asc' }],
  });

  console.log(`Found ${plans.length} active plan(s). Fetching Stripe prices in parallel…\n`);

  const rows = await Promise.all(plans.map(auditPlan));

  const healthy = rows.filter((r) => r.status === 'HEALTHY');
  const issues = rows.filter((r) => r.status !== 'HEALTHY');

  // ── Table output ──────────────────────────────────────────────────────────

  const col = (s: string | null | undefined, w: number) =>
    String(s ?? '—').substring(0, w).padEnd(w);

  console.log(
    col('Plan', 24) +
    col('Local price', 14) +
    col('Stripe price', 14) +
    col('Amt?', 6) +
    col('Cur?', 6) +
    col('Int?', 6) +
    'Status',
  );
  console.log('─'.repeat(80));

  for (const row of rows) {
    const localPrice = fmtCents(row.localPriceCents, row.localCurrency);
    const stripePrice = row.stripeUnitAmount != null
      ? fmtCents(row.stripeUnitAmount, row.stripeCurrency ?? row.localCurrency)
      : '—';
    const amtOk = row.amountMatches == null ? '—' : row.amountMatches ? '✓' : '✗';
    const curOk = row.currencyMatches == null ? '—' : row.currencyMatches ? '✓' : '✗';
    const intOk = row.billingIntervalMatches == null ? '—' : row.billingIntervalMatches ? '✓' : '✗';

    console.log(
      col(row.planName, 24) +
      col(localPrice, 14) +
      col(stripePrice, 14) +
      col(amtOk, 6) +
      col(curOk, 6) +
      col(intOk, 6) +
      statusLabel(row.status),
    );
  }

  console.log(`\n${divider}`);
  console.log(`  SUMMARY: ${healthy.length} healthy, ${issues.length} with issues`);
  console.log(`${divider}\n`);

  if (issues.length > 0) {
    console.log('── ISSUE DETAIL ──\n');
    for (const row of issues) {
      console.log(`${statusLabel(row.status)}: ${row.planName}`);
      console.log(`  Plan ID:         ${row.planId}`);
      console.log(`  Studio ID:       ${row.studioId}`);
      console.log(`  Stripe Price ID: ${row.stripePriceId ?? '(none)'}`);
      if (row.amountMatches === false) {
        console.log(
          `  Amount:          local=${row.localPriceCents} (${fmtCents(row.localPriceCents, row.localCurrency)})` +
          `  ≠  stripe=${row.stripeUnitAmount} (${fmtCents(row.stripeUnitAmount!, row.stripeCurrency ?? row.localCurrency)})`,
        );
      }
      if (row.currencyMatches === false) {
        console.log(`  Currency:        local=${row.localCurrency}  ≠  stripe=${row.stripeCurrency}`);
      }
      if (row.billingIntervalMatches === false) {
        console.log(
          `  Interval:        local=${row.localBillingInterval} (→${localIntervalToStripe(row.localBillingInterval)})` +
          `  ≠  stripe=${row.stripeInterval}`,
        );
      }
      console.log();
    }
  }

  // Proposed DB corrections for PRICE_MISMATCH plans
  const priceMismatches = rows.filter((r) => r.status === 'PRICE_MISMATCH');
  if (priceMismatches.length > 0) {
    console.log('── PROPOSED PRODUCTION CORRECTIONS (review before applying) ──\n');
    console.log('-- Update local priceCents to match Stripe authoritative amounts:');
    for (const row of priceMismatches) {
      console.log(
        `UPDATE membership_plans SET price_cents = ${row.stripeUnitAmount}` +
        ` WHERE id = '${row.planId}';` +
        `  -- ${row.planName}: ${row.localPriceCents} → ${row.stripeUnitAmount}`,
      );
    }
    console.log();
    console.log('DO NOT run these until you have reviewed the findings and obtained approval.');
  }

  console.log(`\n${divider}\n`);

  await prisma.$disconnect();
}

run().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
