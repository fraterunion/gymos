/**
 * Day Pass ↔ Stripe reconciliation (DRY-RUN by default)
 *
 * Classifies every non-ACTIVE Day Pass attempt slot against the LIVE PaymentIntent status in
 * Stripe, verifies ACTIVE passes have a succeeded intent and a Payment row, and looks for paid
 * day-pass intents that never produced an entitlement. Prints aggregate counts plus masked
 * per-row lines; never prints emails, names or card data.
 *
 * Modes
 *   (default)                 READ-ONLY. Reads DB + Stripe (GET / search). No writes anywhere.
 *   --apply --confirm-apply   Applies ONLY these idempotent, non-destructive repairs:
 *                               ACTIVATE_PAID_ATTEMPT   PENDING/EXPIRED slot whose intent succeeded
 *                                                       → ACTIVE + Payment upsert (money was taken;
 *                                                       entitlement follows). Same routine as the webhook.
 *                               EXPIRE_LAPSED_ATTEMPT   PENDING slot for a PAST studio-local day whose
 *                                                       intent is requires_* / canceled / missing → EXPIRED.
 *                             Never deletes a row, never refunds, never touches ACTIVE rows, never
 *                             cancels a succeeded/processing intent.
 *   --cancel-stripe           (with --apply) also cancel the lapsed attempts' intents at Stripe
 *                             (cancellation_reason=abandoned) so they leave the "Incomplete" list.
 *   --studio <id>             restrict to one studio.   --json  machine-readable report.
 *
 * Rollback: every applied change is logged with the slot id and previous status; EXPIRE can be
 * reverted by setting status back to PENDING (the API would re-evaluate it live anyway);
 * ACTIVATE is a true state (Stripe says paid) and should not be reverted — refund instead.
 *
 * Usage
 *   railway run npx tsx scripts/day-pass-reconcile.ts [--studio <id>] [--json]
 *   railway run npx tsx scripts/day-pass-reconcile.ts --apply --confirm-apply [--cancel-stripe]
 *
 * Env required: DATABASE_URL, STRIPE_SECRET_KEY
 * Requires the 20260923120000_day_pass_attempt_lifecycle migration (reads its columns); run it
 * after that migration has been deployed.
 */

import { Logger } from '@nestjs/common';
import { DayPassStatus, PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { getStudioLocalDateKey, studioLocalDateKeyToUtcAnchor } from '../src/common/date/studio-local-date';
import {
  activateDayPassFromSucceededPaymentIntent,
  snapshotFromStripePaymentIntent,
} from '../src/day-passes/day-pass-activation';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const APPLY = flag('--apply') && flag('--confirm-apply');
if (flag('--apply') && !flag('--confirm-apply')) {
  console.error('Refusing to apply: pass BOTH --apply and --confirm-apply.');
  process.exit(2);
}
const CANCEL_STRIPE = APPLY && flag('--cancel-stripe');
const STUDIO_FILTER = opt('--studio');
const JSON_OUT = flag('--json');

const prisma = new PrismaClient();
const stripe = new Stripe(process.env['STRIPE_SECRET_KEY']!, { typescript: true, apiVersion: '2025-08-27.basil' });
const logger = new Logger('day-pass-reconcile');

type Classification =
  | 'HEALTHY_ACTIVE'
  | 'ACTIVE_WITHOUT_STRIPE_SUCCESS' // flag only — never auto-fixed
  | 'ACTIVE_WITHOUT_PAYMENT_ROW' // repaired by re-running activation (Payment upsert)
  | 'ACTIVE_INTENT_REFUNDED' // flag: refund issued at Stripe, row still ACTIVE (manual REFUNDED)
  | 'DOUBLE_CHARGE_SUSPECTED' // flag: a second intent for an ACTIVE slot also succeeded — refund one
  | 'PAID_BUT_REFUNDED_NOT_ACTIVE' // flag: intent succeeded then refunded; never auto-activated
  | 'ACTIVATE_PAID_ATTEMPT'
  | 'EXPIRE_LAPSED_ATTEMPT'
  | 'OPEN_REUSABLE_ATTEMPT' // today/future, requires_* — the API resumes it; nothing to do
  | 'OPEN_CANCELED_ATTEMPT' // today/future, intent canceled — the API replaces it; nothing to do
  | 'PROCESSING_WAIT'
  | 'EXPIRED_OK'
  | 'STRIPE_UNREACHABLE';

type Row = {
  id: string;
  studioId: string;
  userId: string;
  status: DayPassStatus;
  validForDate: Date;
  priceCents: number;
  currency: string;
  stripePaymentIntentId: string | null;
  previousStripePaymentIntentIds: string[];
  createdAt: Date;
};

type Finding = {
  classification: Classification;
  dayPassId: string;
  userId: string;
  validForDate: string;
  localStatus: DayPassStatus;
  stripeStatus: string | null;
  stripePaymentIntentId: string | null;
  priceCents: number;
  currency: string;
  ageDays: number;
  applied?: string;
};

const mask = (id: string | null) => (id ? `${id.slice(0, 4)}…${id.slice(-3)}` : '—');

async function retrieveIntent(id: string): Promise<{ pi: Stripe.PaymentIntent | null; error: 'missing' | 'unreachable' | null }> {
  try {
    return { pi: await stripe.paymentIntents.retrieve(id, { expand: ['latest_charge'] }), error: null };
  } catch (err) {
    const e = err as { code?: string; statusCode?: number };
    if (e.code === 'resource_missing' || e.statusCode === 404) return { pi: null, error: 'missing' };
    return { pi: null, error: 'unreachable' };
  }
}

async function run(): Promise<void> {
  const now = new Date();
  const studios = await prisma.studio.findMany({
    where: { deletedAt: null, ...(STUDIO_FILTER ? { id: STUDIO_FILTER } : {}) },
    select: { id: true, slug: true, timezone: true },
  });

  const findings: Finding[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  for (const studio of studios) {
    const rows: Row[] = await prisma.dayPass.findMany({
      where: { studioId: studio.id },
      select: {
        id: true, studioId: true, userId: true, status: true, validForDate: true,
        priceCents: true, currency: true, stripePaymentIntentId: true,
        previousStripePaymentIntentIds: true, createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) continue;

    const todayKey = getStudioLocalDateKey(now, studio.timezone);
    const todayAnchor = studioLocalDateKeyToUtcAnchor(todayKey, studio.timezone);

    for (const row of rows) {
      const base = {
        dayPassId: row.id,
        userId: row.userId,
        validForDate: getStudioLocalDateKey(row.validForDate, studio.timezone),
        localStatus: row.status,
        stripePaymentIntentId: row.stripePaymentIntentId,
        priceCents: row.priceCents,
        currency: row.currency,
        ageDays: Math.floor((now.getTime() - row.createdAt.getTime()) / 86_400_000),
      };
      const push = (classification: Classification, stripeStatus: string | null, applied?: string) => {
        findings.push({ classification, stripeStatus, ...base, ...(applied ? { applied } : {}) });
        bump(classification);
      };

      const lapsed = row.validForDate.getTime() < todayAnchor.getTime();
      const { pi, error } = row.stripePaymentIntentId
        ? await retrieveIntent(row.stripePaymentIntentId)
        : { pi: null, error: null as null };
      const stripeStatus = pi?.status ?? (error ?? (row.stripePaymentIntentId ? null : 'no_intent'));

      if (row.status === DayPassStatus.ACTIVE) {
        if (error === 'unreachable') { push('STRIPE_UNREACHABLE', stripeStatus); continue; }
        if (!pi || pi.status !== 'succeeded') { push('ACTIVE_WITHOUT_STRIPE_SUCCESS', stripeStatus); continue; }
        const charge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;
        if ((charge?.amount_refunded ?? 0) > 0) {
          push('ACTIVE_INTENT_REFUNDED', charge?.refunded ? 'succeeded+refunded' : 'succeeded+partially_refunded');
          continue;
        }
        // Every REPLACED intent of an ACTIVE slot must be dead; a succeeded one is a double charge.
        for (const prevId of row.previousStripePaymentIntentIds) {
          if (prevId === row.stripePaymentIntentId) continue;
          const prev = await retrieveIntent(prevId);
          if (prev.error === 'unreachable') {
            findings.push({ classification: 'STRIPE_UNREACHABLE', stripeStatus: 'unreachable', ...base, stripePaymentIntentId: prevId });
            bump('STRIPE_UNREACHABLE');
            continue;
          }
          if (prev.pi?.status === 'succeeded') {
            const prevCharge = prev.pi.latest_charge && typeof prev.pi.latest_charge !== 'string' ? prev.pi.latest_charge : null;
            if ((prevCharge?.amount_refunded ?? 0) === 0) {
              findings.push({ classification: 'DOUBLE_CHARGE_SUSPECTED', stripeStatus: 'succeeded', ...base, stripePaymentIntentId: prevId });
              bump('DOUBLE_CHARGE_SUSPECTED');
            }
          }
        }
        const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: pi.id }, select: { id: true } });
        if (!payment) {
          let applied: string | undefined;
          if (APPLY) {
            const outcome = await activateDayPassFromSucceededPaymentIntent(prisma, logger, snapshotFromStripePaymentIntent(pi), 'reconciliation');
            applied = `payment_row:${outcome.outcome}${outcome.outcome === 'ignored' ? `(${outcome.reason})` : ''}`;
          }
          push('ACTIVE_WITHOUT_PAYMENT_ROW', stripeStatus, applied);
          continue;
        }
        push('HEALTHY_ACTIVE', stripeStatus);
        continue;
      }

      if (row.status === DayPassStatus.REFUNDED) { push('EXPIRED_OK', stripeStatus); continue; }
      if (error === 'unreachable') { push('STRIPE_UNREACHABLE', stripeStatus); continue; }

      if (pi?.status === 'succeeded') {
        const charge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;
        if ((charge?.amount_refunded ?? 0) > 0) { push('PAID_BUT_REFUNDED_NOT_ACTIVE', 'succeeded+refunded'); continue; }
        let applied: string | undefined;
        if (APPLY) {
          const outcome = await activateDayPassFromSucceededPaymentIntent(prisma, logger, snapshotFromStripePaymentIntent(pi), 'reconciliation');
          applied = `activated:${outcome.outcome}${outcome.outcome === 'ignored' ? `(${outcome.reason})` : ''}`;
        }
        push('ACTIVATE_PAID_ATTEMPT', stripeStatus, applied);
        continue;
      }
      if (pi?.status === 'processing' || pi?.status === 'requires_capture') { push('PROCESSING_WAIT', stripeStatus); continue; }

      if (row.status === DayPassStatus.EXPIRED) { push('EXPIRED_OK', stripeStatus); continue; }

      // PENDING with a non-succeeded, non-processing intent (or no intent / missing intent)
      if (!lapsed) {
        push(pi?.status === 'canceled' ? 'OPEN_CANCELED_ATTEMPT' : 'OPEN_REUSABLE_ATTEMPT', stripeStatus);
        continue;
      }
      let applied: string | undefined;
      if (APPLY) {
        if (CANCEL_STRIPE && pi && pi.status !== 'canceled') {
          try { await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: 'abandoned' }); applied = 'stripe_canceled+'; }
          catch (e) { applied = `stripe_cancel_failed(${e instanceof Error ? e.message : String(e)})+`; }
        }
        const r = await prisma.dayPass.updateMany({
          where: { id: row.id, status: DayPassStatus.PENDING, stripePaymentIntentId: row.stripePaymentIntentId },
          data: { status: DayPassStatus.EXPIRED, expiredAt: now, lastStripeStatus: stripeStatus ?? undefined },
        });
        applied = `${applied ?? ''}expired:${r.count}`;
      }
      push('EXPIRE_LAPSED_ATTEMPT', stripeStatus, applied);
    }

    // Paid day-pass intents in Stripe with no ACTIVE slot (webhook lost AND never retried/synced).
    // Stripe Search is eventually consistent (minutes); treat as a signal, not proof.
    try {
      const paidIntents: Stripe.PaymentIntent[] = [];
      let page: string | undefined;
      for (;;) {
        const res = await stripe.paymentIntents.search({
          query: `metadata['type']:'day_pass' AND metadata['studioId']:'${studio.id}' AND status:'succeeded'`,
          limit: 100,
          expand: ['data.latest_charge'],
          ...(page ? { page } : {}),
        });
        paidIntents.push(...res.data);
        if (!res.has_more || !res.next_page) break;
        page = res.next_page;
      }
      const alreadyReported = new Set(findings.map((f) => f.stripePaymentIntentId).filter(Boolean));
      for (const pi of paidIntents) {
        if (alreadyReported.has(pi.id)) continue;
        const searchCharge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;
        if ((searchCharge?.amount_refunded ?? 0) > 0) continue; // refunded money: nothing to activate or refund
        const dayPassId = pi.metadata['dayPassId'];
        const local = dayPassId
          ? await prisma.dayPass.findUnique({ where: { id: dayPassId }, select: { status: true, stripePaymentIntentId: true } })
          : null;
        if (local?.status === DayPassStatus.REFUNDED) continue;
        if (local?.status === DayPassStatus.ACTIVE && local.stripePaymentIntentId !== pi.id) {
          // Paid intent that is not the ACTIVE slot's intent of record: second charge for one pass.
          if (!findings.some((f) => f.classification === 'DOUBLE_CHARGE_SUSPECTED' && f.stripePaymentIntentId === pi.id)) {
            bump('DOUBLE_CHARGE_SUSPECTED');
            findings.push({
              classification: 'DOUBLE_CHARGE_SUSPECTED',
              dayPassId: dayPassId!,
              userId: pi.metadata['userId'] ?? '?',
              validForDate: pi.metadata['validForDate'] ?? '?',
              localStatus: DayPassStatus.ACTIVE,
              stripeStatus: 'succeeded',
              stripePaymentIntentId: pi.id,
              priceCents: pi.amount,
              currency: pi.currency,
              ageDays: Math.floor((now.getTime() - pi.created * 1000) / 86_400_000),
            });
          }
          continue;
        }
        if (!local || local.status !== DayPassStatus.ACTIVE) {
          bump('PAID_INTENT_WITHOUT_ACTIVE_PASS');
          findings.push({
            classification: 'ACTIVATE_PAID_ATTEMPT',
            dayPassId: dayPassId ?? '(no dayPassId metadata)',
            userId: pi.metadata['userId'] ?? '?',
            validForDate: pi.metadata['validForDate'] ?? '?',
            localStatus: local?.status ?? ('MISSING' as DayPassStatus),
            stripeStatus: 'succeeded',
            stripePaymentIntentId: pi.id,
            priceCents: pi.amount,
            currency: pi.currency,
            ageDays: Math.floor((now.getTime() - pi.created * 1000) / 86_400_000),
          });
        }
      }
    } catch (e) {
      bump('STRIPE_SEARCH_UNAVAILABLE');
      if (!JSON_OUT) console.log(`  (Stripe search unavailable for ${studio.slug}: ${e instanceof Error ? e.message : String(e)})`);
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'DRY_RUN', cancelStripe: CANCEL_STRIPE, at: now.toISOString(), counts, findings }, null, 2));
  } else {
    console.log(`\n${'═'.repeat(70)}\nDAY PASS RECONCILIATION — ${APPLY ? 'APPLY' : 'DRY RUN (no writes)'}${CANCEL_STRIPE ? ' + Stripe cancel' : ''} — ${now.toISOString()}\n${'═'.repeat(70)}\n`);
    console.log('── COUNTS ──');
    for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(34)} ${v}`);
    console.log('\n── ROWS (ids masked) ──');
    for (const f of findings) {
      if (f.classification === 'HEALTHY_ACTIVE') continue;
      console.log(
        `  [${f.classification}] slot=${mask(f.dayPassId)} user=${mask(f.userId)} date=${f.validForDate} local=${f.localStatus} stripe=${f.stripeStatus ?? '—'} pi=${mask(f.stripePaymentIntentId)} ${(f.priceCents / 100).toFixed(2)} ${f.currency.toUpperCase()} age=${f.ageDays}d${f.applied ? ` applied=${f.applied}` : ''}`,
      );
    }
    console.log(`\n${'═'.repeat(70)}\n`);
  }

  const actionable = (counts['ACTIVE_WITHOUT_STRIPE_SUCCESS'] ?? 0) + (counts['ACTIVATE_PAID_ATTEMPT'] ?? 0) + (counts['PAID_INTENT_WITHOUT_ACTIVE_PASS'] ?? 0) + (counts['ACTIVE_INTENT_REFUNDED'] ?? 0) + (counts['DOUBLE_CHARGE_SUSPECTED'] ?? 0) + (counts['PAID_BUT_REFUNDED_NOT_ACTIVE'] ?? 0);
  if (actionable > 0 && !APPLY) process.exitCode = 1;
  await prisma.$disconnect();
}

run().catch((err) => {
  console.error('Reconciliation failed:', err);
  process.exit(1);
});
