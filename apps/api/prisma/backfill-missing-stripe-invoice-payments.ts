/**
 * Idempotent allowlisted backfill for two live-mode Stripe subscription invoices
 * whose invoice.paid webhooks were processed but produced no Payment rows due to
 * Stripe API 2025-08-27.basil removing invoice.subscription from the invoice root.
 *
 * Only the two invoice IDs in ALLOWLIST are eligible. The script validates all
 * referenced DB records and, when STRIPE_SECRET_KEY is available, cross-checks
 * each invoice against Stripe before writing.
 *
 * Usage:
 *   DATABASE_URL="..." pnpm --filter api backfill:missing-stripe-invoice-payments
 *
 * Dry run (no writes):
 *   DATABASE_URL="..." DRY_RUN=true pnpm --filter api backfill:missing-stripe-invoice-payments
 */

import Stripe from 'stripe';
import { PaymentMethod, PaymentStatus, PrismaClient } from '@prisma/client';
import { readStripeInvoiceSubscriptionId } from '../src/billing/stripe-invoice.utils';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === 'true';
const STRIPE_API_VERSION = '2025-08-27.basil' as const;

type BackfillRow = {
  label: string;
  stripeInvoiceId: string;
  studioId: string;
  userId: string;
  subscriptionId: string;
  membershipPlanId: string;
  amountCents: number;
  currency: string;
  paidAt: Date;
};

const ALLOWLIST: BackfillRow[] = [
  {
    label:            'Anacecilia Ramirez (ganaceci11@hotmail.com)',
    stripeInvoiceId:  'in_1TnlcOGuUoCXNORE7y7Hmnbg',
    studioId:         'cmp33m0gp0000qomlj9p42ia5',
    userId:           'cmqznkvbk0044qo0riyfxq0im',
    subscriptionId:   'cmqznsymt004iqo0rqbvtud9x',
    membershipPlanId: 'cmqzn1r95003zqo0rh16v6nbf',
    amountCents:      60000,
    currency:         'mxn',
    paidAt:           new Date('2026-06-29T20:17:25.000Z'),
  },
  {
    label:            'Emilia Gonzalez (emiliagonzaleztru007@gmail.com)',
    stripeInvoiceId:  'in_1TqKw3GuUoCXNOREPnr7lOTm',
    studioId:         'cmp33m0gp0000qomlj9p42ia5',
    userId:           'cmr27x7vc0004m60rgy4bqjpq',
    subscriptionId:   'cmr9sf4iw004ym60rimrr0a7f',
    membershipPlanId: 'cmq1y1sqe000xenswkzsfwq28',
    amountCents:      130000,
    currency:         'mxn',
    paidAt:           new Date('2026-07-06T22:24:20.000Z'),
  },
];

function sep() {
  console.log('══════════════════════════════════════════════════════════════');
}

async function verifyStripeInvoice(
  stripe: Stripe,
  row: BackfillRow,
  expectedStripeSubscriptionId: string,
): Promise<void> {
  let inv: Stripe.Invoice;
  try {
    inv = await stripe.invoices.retrieve(row.stripeInvoiceId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Stripe invoice ${row.stripeInvoiceId} could not be retrieved: ${msg}`);
  }

  if (!inv.livemode) {
    throw new Error(
      `Invoice ${row.stripeInvoiceId} is test-mode. Aborting — only live-mode invoices may be backfilled.`,
    );
  }
  if (inv.status !== 'paid') {
    throw new Error(
      `Invoice ${row.stripeInvoiceId} has status "${inv.status}", expected "paid". Aborting.`,
    );
  }
  if (inv.amount_paid !== row.amountCents) {
    throw new Error(
      `Invoice ${row.stripeInvoiceId} amount_paid mismatch: Stripe=${inv.amount_paid}, allowlist=${row.amountCents}. Aborting.`,
    );
  }
  if ((inv.currency ?? '').toLowerCase() !== row.currency.toLowerCase()) {
    throw new Error(
      `Invoice ${row.stripeInvoiceId} currency mismatch: Stripe=${inv.currency}, allowlist=${row.currency}. Aborting.`,
    );
  }

  const stripeSubId = readStripeInvoiceSubscriptionId(inv);
  if (!stripeSubId) {
    throw new Error(
      `Invoice ${row.stripeInvoiceId} has no resolvable subscription ID in Stripe. Aborting.`,
    );
  }
  if (stripeSubId !== expectedStripeSubscriptionId) {
    throw new Error(
      `Invoice ${row.stripeInvoiceId} subscription mismatch: Stripe=${stripeSubId}, allowlisted=${expectedStripeSubscriptionId}. Aborting.`,
    );
  }

  const paidAt = inv.status_transitions?.paid_at
    ? new Date(inv.status_transitions.paid_at * 1000)
    : null;
  if (!paidAt) {
    throw new Error(`Invoice ${row.stripeInvoiceId} has no paid_at timestamp. Aborting.`);
  }
  if (Math.abs(paidAt.getTime() - row.paidAt.getTime()) > 5000) {
    throw new Error(
      `Invoice ${row.stripeInvoiceId} paid_at mismatch: Stripe=${paidAt.toISOString()}, allowlist=${row.paidAt.toISOString()}. Aborting.`,
    );
  }

  console.log(`  [Stripe ✓] livemode=true, status=paid, amount_paid=${inv.amount_paid}, currency=${inv.currency}, subscription=${stripeSubId}`);
}

async function processRow(stripe: Stripe | null, row: BackfillRow): Promise<void> {
  console.log(`\n── ${row.label}`);
  console.log(`   stripeInvoiceId  : ${row.stripeInvoiceId}`);
  console.log(`   studioId         : ${row.studioId}`);
  console.log(`   userId           : ${row.userId}`);
  console.log(`   subscriptionId   : ${row.subscriptionId}`);
  console.log(`   membershipPlanId : ${row.membershipPlanId}`);
  console.log(`   amountCents      : ${row.amountCents} (${row.currency.toUpperCase()} ${(row.amountCents / 100).toFixed(2)})`);
  console.log(`   paidAt           : ${row.paidAt.toISOString()}`);

  // DB validation: all referenced records must exist before Stripe cross-check
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { id: true, email: true, deletedAt: true } });
  if (!user) throw new Error(`User ${row.userId} not found in DB`);
  if (user.deletedAt) throw new Error(`User ${row.userId} is deleted`);
  console.log(`  [DB ✓]    user: ${user.email}`);

  const studio = await prisma.studio.findUnique({ where: { id: row.studioId }, select: { id: true, name: true } });
  if (!studio) throw new Error(`Studio ${row.studioId} not found in DB`);
  console.log(`  [DB ✓]    studio: ${studio.name}`);

  const sub = await prisma.subscription.findUnique({
    where: { id: row.subscriptionId },
    select: {
      id: true,
      userId: true,
      studioId: true,
      membershipPlanId: true,
      status: true,
      stripeSubscriptionId: true,
    },
  });
  if (!sub) throw new Error(`Subscription ${row.subscriptionId} not found in DB`);
  if (sub.userId !== row.userId) throw new Error(`Subscription ${row.subscriptionId} userId mismatch`);
  if (sub.studioId !== row.studioId) throw new Error(`Subscription ${row.subscriptionId} studioId mismatch`);
  if (!sub.stripeSubscriptionId) {
    throw new Error(`Subscription ${row.subscriptionId} has no stripeSubscriptionId. Aborting.`);
  }
  console.log(`  [DB ✓]    subscription: status=${sub.status}, stripeSubscriptionId=${sub.stripeSubscriptionId}`);

  const plan = await prisma.membershipPlan.findFirst({
    where: { id: row.membershipPlanId, studioId: row.studioId, deletedAt: null },
    select: { id: true, name: true, priceCents: true },
  });
  if (!plan) throw new Error(`MembershipPlan ${row.membershipPlanId} not found for studio ${row.studioId}`);
  console.log(`  [DB ✓]    plan: "${plan.name}" (catalog price: ${plan.priceCents} — NOT used as payment amount)`);

  if (stripe) {
    await verifyStripeInvoice(stripe, row, sub.stripeSubscriptionId);
  } else {
    console.log('  [Stripe]  STRIPE_SECRET_KEY not set — skipping Stripe cross-check');
  }

  // Idempotency check
  const existing = await prisma.payment.findUnique({
    where: { stripeInvoiceId: row.stripeInvoiceId },
    select: { id: true, amountCents: true, status: true, paidAt: true },
  });

  if (existing) {
    console.log(`  [SKIP]    Payment already exists: id=${existing.id}, amountCents=${existing.amountCents}, status=${existing.status}`);
    return;
  }

  const proposed = {
    studioId:             row.studioId,
    userId:               row.userId,
    subscriptionId:       row.subscriptionId,
    membershipPlanId:     row.membershipPlanId,
    amountCents:          row.amountCents,
    currency:             row.currency.toLowerCase(),
    status:               PaymentStatus.SUCCEEDED,
    paymentMethod:        PaymentMethod.STRIPE,
    stripeInvoiceId:      row.stripeInvoiceId,
    stripePaymentIntentId: null,
    paidAt:               row.paidAt,
  };

  console.log(`  [PROPOSED] ${JSON.stringify(proposed, null, 4)}`);

  if (DRY_RUN) {
    console.log('  [DRY_RUN] No write performed.');
    return;
  }

  const created = await prisma.payment.upsert({
    where: { stripeInvoiceId: row.stripeInvoiceId },
    create: proposed,
    update: {},
  });
  console.log(`  [WRITTEN] Payment id=${created.id}`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  sep();
  console.log('  MISSING STRIPE INVOICE PAYMENTS — BACKFILL');
  console.log(`  Mode     : ${DRY_RUN ? 'DRY_RUN (no writes)' : 'WRITE'}`);
  console.log(`  Invoices : ${ALLOWLIST.length} (allowlisted only)`);
  sep();

  const stripe: Stripe | null = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION })
    : null;

  if (!stripe) {
    console.warn('  WARNING: STRIPE_SECRET_KEY not set — Stripe cross-validation skipped.');
  }

  let failures = 0;
  for (const row of ALLOWLIST) {
    try {
      await processRow(stripe, row);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`\n  [ERROR] ${row.label}: ${msg}`);
      failures++;
    }
  }

  console.log('');
  sep();
  if (failures > 0) {
    console.error(`  COMPLETED WITH ${failures} ERROR(S). No partial writes on failed rows.`);
    sep();
    process.exit(1);
  }
  console.log(`  COMPLETED. ${DRY_RUN ? 'Dry run — no rows written.' : 'All rows processed.'}`);
  sep();
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
