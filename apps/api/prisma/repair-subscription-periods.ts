/**
 * Repair script — back-fills or corrects currentPeriodStart/currentPeriodEnd for
 * Stripe-managed subscriptions.
 *
 * Background:
 *   The Stripe basil API (2025-08-27.basil) removed current_period_start /
 *   current_period_end from the Subscription root object. Those fields moved
 *   to each SubscriptionItem:
 *     subscription.items.data[0].current_period_start  (Unix seconds)
 *     subscription.items.data[0].current_period_end    (Unix seconds)
 *
 *   Invoice.period_start / period_end are a collection-window timestamp
 *   (both equal the same instant for a standard recurring invoice) and must
 *   NOT be used as the billing period. An earlier run of this script
 *   mistakenly wrote those equal timestamps to the DB.
 *
 * Modes:
 *   Default (REPAIR_EQUAL_PERIODS unset or false):
 *     Repairs ACTIVE/TRIALING rows where stripeSubscriptionId IS NOT NULL
 *     AND currentPeriodEnd IS NULL.
 *
 *   REPAIR_EQUAL_PERIODS=true:
 *     Also repairs rows where currentPeriodStart IS NOT NULL AND
 *     currentPeriodEnd IS NOT NULL AND currentPeriodStart = currentPeriodEnd
 *     (the result of the wrong invoice.period_start/end repair).
 *
 * Source of truth:
 *   subscription.items.data[0].current_period_start
 *   subscription.items.data[0].current_period_end
 *
 * Usage:
 *   # Diagnostic preview — no writes:
 *   DRY_RUN=true DATABASE_URL="postgresql://..." STRIPE_SECRET_KEY="sk_live_..." \
 *     ts-node --project tsconfig.seed.json prisma/repair-subscription-periods.ts
 *
 *   # Repair null periods AND equal-timestamp periods:
 *   REPAIR_EQUAL_PERIODS=true DATABASE_URL="postgresql://..." STRIPE_SECRET_KEY="sk_live_..." \
 *     ts-node --project tsconfig.seed.json prisma/repair-subscription-periods.ts
 *
 *   # Dry-run for equal-period rows only (preview before writing):
 *   DRY_RUN=true REPAIR_EQUAL_PERIODS=true DATABASE_URL="postgresql://..." STRIPE_SECRET_KEY="sk_live_..." \
 *     ts-node --project tsconfig.seed.json prisma/repair-subscription-periods.ts
 */

import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';

const prisma = new PrismaClient();
const DRY_RUN              = process.env.DRY_RUN              === 'true';
const REPAIR_EQUAL_PERIODS = process.env.REPAIR_EQUAL_PERIODS === 'true';

const STRIPE_API_VERSION = '2025-08-27.basil' as const;

function requireEnv(key: string): string {
  const val = process.env[key]?.trim();
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function parsePeriodDate(value: number | null | undefined): Date | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

function fmtDate(d: Date | null): string {
  return d ? d.toISOString() : 'null';
}

function fmtTs(value: number | null | undefined): string {
  const d = parsePeriodDate(value);
  return d ? d.toISOString() : `null (raw=${value})`;
}

async function main(): Promise<void> {
  console.log('════════════════════════════════════════════════');
  console.log(`  DRY RUN              : ${DRY_RUN}`);
  console.log(`  REPAIR_EQUAL_PERIODS : ${REPAIR_EQUAL_PERIODS}`);
  if (DRY_RUN) console.log('  Zero writes will occur.');
  console.log('════════════════════════════════════════════════\n');

  const stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
    typescript: true,
    apiVersion: STRIPE_API_VERSION,
  });

  // ── 1. Fetch all candidates, filter in JS ─────────────────────────────────
  // Prisma doesn't support field-to-field comparison in where clauses, so we
  // fetch all active/trialing Stripe-managed subscriptions and filter locally.
  const candidates = await prisma.subscription.findMany({
    where: {
      stripeSubscriptionId: { not: null },
      status: { in: ['ACTIVE', 'TRIALING'] },
    },
    select: {
      id: true,
      stripeSubscriptionId: true,
      status: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const affected = candidates.filter((sub) => {
    // Always include rows with null currentPeriodEnd.
    if (sub.currentPeriodEnd === null) return true;
    // Optionally include rows where start and end are both set but equal
    // (the result of the wrong invoice.period_start/end repair).
    if (
      REPAIR_EQUAL_PERIODS &&
      sub.currentPeriodStart !== null &&
      sub.currentPeriodEnd !== null &&
      sub.currentPeriodStart.getTime() === sub.currentPeriodEnd.getTime()
    ) {
      return true;
    }
    return false;
  });

  const nullCount  = affected.filter((s) => s.currentPeriodEnd === null).length;
  const equalCount = affected.length - nullCount;

  console.log(`Candidates fetched  : ${candidates.length}`);
  console.log(`Null period rows    : ${nullCount}`);
  console.log(`Equal period rows   : ${equalCount}${REPAIR_EQUAL_PERIODS ? '' : ' (skipped — set REPAIR_EQUAL_PERIODS=true to include)'}`);
  console.log(`Total to process    : ${affected.length}\n`);

  if (affected.length === 0) {
    console.log('Nothing to repair.');
    return;
  }

  let repaired = 0;
  let skipped  = 0;
  let errored  = 0;

  // ── 2. Process each row ───────────────────────────────────────────────────
  for (const sub of affected) {
    const stripeSubId = sub.stripeSubscriptionId!;
    const reason = sub.currentPeriodEnd === null ? 'null_period' : 'equal_period';

    console.log(`────────────────────────────────────────`);
    console.log(`DB id          : ${sub.id}  [${reason}]`);
    console.log(`Stripe sub id  : ${stripeSubId}`);
    console.log(`Status         : ${sub.status}`);
    console.log(`Before (DB)    : start=${fmtDate(sub.currentPeriodStart)}  end=${fmtDate(sub.currentPeriodEnd)}`);

    let stripeSub: Stripe.Subscription;
    try {
      stripeSub = await stripe.subscriptions.retrieve(stripeSubId, {
        expand: ['latest_invoice', 'latest_invoice.lines'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR — Stripe API error: ${msg}\n`);
      errored++;
      continue;
    }

    // ── Diagnostic: subscription and item fields ──────────────────────────
    console.log(`\n[Subscription]`);
    console.log(`  billing_cycle_anchor : ${fmtTs(stripeSub.billing_cycle_anchor)}`);

    const items = stripeSub.items?.data ?? [];
    console.log(`\n[SubscriptionItem] (${items.length} item(s))`);
    for (const item of items) {
      console.log(`  item.id                    : ${item.id}`);
      console.log(`  item.current_period_start  : ${fmtTs(item.current_period_start)}`);
      console.log(`  item.current_period_end    : ${fmtTs(item.current_period_end)}`);
    }

    const inv = stripeSub.latest_invoice;
    if (!inv || typeof inv === 'string') {
      console.log(`\n[Invoice] — not expanded`);
    } else {
      const invoice = inv as Stripe.Invoice;
      console.log(`\n[Invoice]`);
      console.log(`  invoice.id           : ${invoice.id}`);
      console.log(`  invoice.period_start : ${fmtTs(invoice.period_start)}  ← collection window (NOT billing period)`);
      console.log(`  invoice.period_end   : ${fmtTs(invoice.period_end)}    ← collection window (NOT billing period)`);

      const lines = invoice.lines?.data ?? [];
      console.log(`\n[Invoice Lines] (${lines.length} line(s))`);
      for (const line of lines) {
        const lineItem = line as Stripe.InvoiceLineItem;
        console.log(`  line.id           : ${lineItem.id}`);
        console.log(`  line.description  : ${lineItem.description ?? '(none)'}`);
        console.log(`  line.period.start : ${fmtTs(lineItem.period?.start)}`);
        console.log(`  line.period.end   : ${fmtTs(lineItem.period?.end)}`);
        console.log('');
      }
    }

    // ── Resolve period from subscription item (basil canonical source) ────
    const firstItem  = items[0];
    const periodStart = parsePeriodDate(firstItem?.current_period_start);
    const periodEnd   = parsePeriodDate(firstItem?.current_period_end);

    console.log(`[Resolved period]`);
    console.log(`  source      : subscription.items.data[0].current_period_start/end`);
    console.log(`  periodStart : ${periodStart?.toISOString() ?? 'null — SKIP'}`);
    console.log(`  periodEnd   : ${periodEnd?.toISOString() ?? 'null — SKIP'}`);

    if (!periodStart || !periodEnd) {
      console.log(`  → SKIP (could not resolve valid period)\n`);
      skipped++;
      continue;
    }

    if (periodStart.getTime() === periodEnd.getTime()) {
      console.log(`  → SKIP (resolved period still has equal start/end — Stripe data may not be ready)\n`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  → [DRY] Would write to DB\n`);
      repaired++;
      continue;
    }

    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        currentPeriodStart: periodStart,
        currentPeriodEnd:   periodEnd,
      },
    });
    console.log(`  → WROTE to DB ✓\n`);
    repaired++;
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('════════════════════════════════════════════════');
  console.log(
    JSON.stringify(
      {
        event: 'repair_subscription_periods_complete',
        dry_run: DRY_RUN,
        repair_equal_periods: REPAIR_EQUAL_PERIODS,
        null_period_rows: nullCount,
        equal_period_rows: equalCount,
        total_processed: affected.length,
        repaired,
        skipped,
        errored,
      },
      null,
      2,
    ),
  );

  if (!DRY_RUN && repaired > 0) {
    console.log(`\n✓ Wrote correct billing period to ${repaired} subscription(s).`);
  }
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
