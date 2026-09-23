import type { Logger } from '@nestjs/common';
import { DayPassStatus, PaymentStatus, type Prisma, type PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { logDayPassEvent } from './day-pass-events';

/**
 * The ONE place a Day Pass becomes ACTIVE.
 *
 * Both the Stripe webhook (payment_intent.succeeded) and the API's server-side PaymentIntent
 * retrieval (retry path, post-payment sync, reconciliation) funnel through here, so the
 * activation rules cannot drift between entry points. Input is always a PaymentIntent that
 * Stripe reported as `succeeded` — never a client claim.
 *
 * Idempotent: re-running for the same intent leaves one ACTIVE row and one Payment row.
 * Kept free of Nest DI so BillingModule can use it without importing DayPassesModule
 * (DayPassesModule → SalesModule → BillingModule would otherwise be a cycle).
 */

export type ActivationSource = 'webhook' | 'api' | 'reconciliation';

/** Fields of a PaymentIntent the activation rules need; built from SDK or webhook shapes. */
export type SucceededPaymentIntentSnapshot = {
  id: string;
  status: string;
  amount: number | null;
  currency: string | null;
  /** Unix seconds. */
  created: number | null;
  metadata: Record<string, string> | null;
  /**
   * Refunded amount on the intent's latest charge when known (API retrievals expand it; webhook
   * payloads carry only the charge id → null). A refunded payment never activates a pass.
   */
  amountRefunded?: number | null;
};

export type ActivationOutcome =
  | {
      outcome: 'activated';
      dayPassId: string;
      /**
       * Set when the paid intent was a REPLACED one and the slot still held a different, unpaid
       * current intent: that intent is now superseded and the caller (which owns a Stripe
       * client) should cancel it best-effort so it can never also be paid.
       */
      supersededIntentId?: string;
    }
  | { outcome: 'already_active'; dayPassId: string }
  | { outcome: 'ignored'; reason: string; dayPassId: string | null };

type Db = PrismaClient | Prisma.TransactionClient;

export function snapshotFromStripePaymentIntent(pi: Stripe.PaymentIntent): SucceededPaymentIntentSnapshot {
  const charge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;
  return {
    id: pi.id,
    status: pi.status,
    amount: typeof pi.amount === 'number' ? pi.amount : null,
    currency: pi.currency ?? null,
    created: typeof pi.created === 'number' ? pi.created : null,
    metadata: (pi.metadata as Record<string, string> | null) ?? null,
    amountRefunded: charge ? charge.amount_refunded : null,
  };
}

/** Re-reads allowed when a concurrent writer changes the slot between our read and our write. */
const MAX_ACTIVATION_ATTEMPTS = 3;

export async function activateDayPassFromSucceededPaymentIntent(
  db: Db,
  logger: Logger,
  pi: SucceededPaymentIntentSnapshot,
  source: ActivationSource,
  eventId: string | null = null,
): Promise<ActivationOutcome> {
  const base = { stripePaymentIntentId: pi.id, source, eventId };
  const ignore = (reason: string, dayPassId: string | null, extra: Record<string, unknown> = {}) => {
    logDayPassEvent(logger, 'DAY_PASS_WEBHOOK_IGNORED', { ...base, dayPassId, reason, ...extra }, 'warn');
    return { outcome: 'ignored' as const, reason, dayPassId };
  };

  if (pi.status !== 'succeeded') {
    return ignore('not_succeeded', null, { stripeStatus: pi.status });
  }
  const md = pi.metadata;
  if (!md || md['type'] !== 'day_pass') {
    return ignore('not_day_pass', null);
  }
  const dayPassId = md['dayPassId'] ?? null;
  const studioId = md['studioId'] ?? null;
  const userId = md['userId'] ?? null;
  if (!dayPassId || !studioId || !userId) {
    return ignore('metadata_incomplete', dayPassId);
  }
  if ((pi.amountRefunded ?? 0) > 0) {
    return ignore('refunded_at_stripe', dayPassId, { amountRefunded: pi.amountRefunded });
  }
  const existingPayment = await db.payment.findUnique({
    where: { stripePaymentIntentId: pi.id },
    select: { status: true },
  });
  if (existingPayment && (existingPayment.status === PaymentStatus.REFUNDED || existingPayment.status === PaymentStatus.PARTIALLY_REFUNDED)) {
    // Never grant on refunded money, and never flip the refund record back to SUCCEEDED.
    return ignore('payment_refunded', dayPassId, { paymentStatus: existingPayment.status });
  }

  // Read → decide → compare-and-swap write. A concurrent retry may replace the slot's intent
  // (or another delivery may activate it) between our read and our write; the conditional
  // update then matches nothing and we re-evaluate against the fresh row instead of
  // overwriting it. This keeps every intent the slot ever issued in its trail, so an unpaid
  // replacement can always be found and cancelled, and a paid one always activates.
  for (let attempt = 1; attempt <= MAX_ACTIVATION_ATTEMPTS; attempt++) {
    const dayPass = await db.dayPass.findUnique({
      where: { id: dayPassId },
      select: {
        id: true,
        studioId: true,
        userId: true,
        status: true,
        priceCents: true,
        currency: true,
        stripePaymentIntentId: true,
        previousStripePaymentIntentIds: true,
        validForDate: true,
      },
    });
    if (!dayPass) {
      return ignore('day_pass_not_found', dayPassId);
    }
    if (dayPass.studioId !== studioId || dayPass.userId !== userId) {
      return ignore('tenant_mismatch', dayPassId);
    }

    const isCurrentIntent = dayPass.stripePaymentIntentId === null || dayPass.stripePaymentIntentId === pi.id;
    const isPreviousIntent = dayPass.previousStripePaymentIntentIds.includes(pi.id);
    if (!isCurrentIntent && !isPreviousIntent) {
      // An intent this slot never issued. Refuse to grant on it; operators see the warning.
      return ignore('unknown_intent_for_slot', dayPassId, { currentIntent: dayPass.stripePaymentIntentId });
    }

    if (dayPass.status === DayPassStatus.REFUNDED) {
      return ignore('terminal_refunded', dayPassId);
    }

    const fields = {
      ...base,
      dayPassId,
      studioId,
      userId,
      validForDate: dayPass.validForDate.toISOString().slice(0, 10),
      priceCents: pi.amount,
      currency: pi.currency,
    };

    const now = new Date();
    // Record the money FIRST (idempotent upsert keyed by the intent). Stripe says it moved, so the
    // Payment row is true whatever happens to the slot write below; and if the process dies
    // between the two, the redelivery still finds the slot un-promoted and completes the swap
    // (including cancelling any superseded intent) instead of seeing a half-finished ACTIVE.
    const paidAt = pi.created ? new Date(pi.created * 1000) : now;
    await db.payment.upsert({
      where: { stripePaymentIntentId: pi.id },
      create: {
        studioId: dayPass.studioId,
        userId: dayPass.userId,
        amountCents: pi.amount ?? dayPass.priceCents,
        currency: (pi.currency ?? dayPass.currency).toLowerCase(),
        status: PaymentStatus.SUCCEEDED,
        stripePaymentIntentId: pi.id,
        paidAt,
      },
      update: {
        status: PaymentStatus.SUCCEEDED,
        paidAt,
      },
    });

    let outcome: ActivationOutcome;
    if (dayPass.status !== DayPassStatus.ACTIVE) {
      // A paid REPLACED intent becomes the slot's intent of record (so Payment ↔ DayPass join on
      // stripe_payment_intent_id stays truthful); the unpaid current one moves to the trail and
      // is reported back so the caller cancels it at Stripe.
      const supersededIntentId =
        !isCurrentIntent && dayPass.stripePaymentIntentId !== null ? dayPass.stripePaymentIntentId : undefined;
      const swapped = await db.dayPass.updateMany({
        where: {
          id: dayPassId,
          status: dayPass.status,
          stripePaymentIntentId: dayPass.stripePaymentIntentId,
        },
        data: {
          status: DayPassStatus.ACTIVE,
          stripePaymentIntentId: pi.id,
          // The paid intent leaves the trail (it is now the intent of record) and the superseded
          // one joins it. Safe as a full write: the trail only changes together with the status or
          // the current intent, both pinned by this compare-and-swap.
          ...(supersededIntentId
            ? {
                previousStripePaymentIntentIds: [
                  ...dayPass.previousStripePaymentIntentIds.filter((id) => id !== pi.id),
                  supersededIntentId,
                ],
              }
            : {}),
          lastStripeStatus: 'succeeded',
          lastPaymentErrorCode: null,
          lastPaymentDeclineCode: null,
          activatedAt: now,
          expiredAt: null,
        },
      });
      if (swapped.count === 0) {
        continue; // the slot moved under us; re-read and re-decide
      }
      logActivationAnomalies(logger, fields, pi, dayPass, isCurrentIntent, isPreviousIntent);
      logDayPassEvent(logger, 'DAY_PASS_ACTIVATED', { ...fields, supersededIntentId, attempt });
      outcome = supersededIntentId
        ? { outcome: 'activated', dayPassId, supersededIntentId }
        : { outcome: 'activated', dayPassId };
    } else {
      // Already ACTIVE. If this is a DIFFERENT (replaced) intent being paid too, the member was
      // charged twice: the Payment row below records it and the anomaly event flags it for a
      // refund. The ACTIVE binding is left on the intent that activated the pass.
      logActivationAnomalies(logger, fields, pi, dayPass, isCurrentIntent, isPreviousIntent);
      outcome = { outcome: 'already_active', dayPassId };
    }

    logDayPassEvent(logger, 'DAY_PASS_PAYMENT_SUCCEEDED', { ...fields, outcome: outcome.outcome });
    return outcome;
  }

  // Persistent contention is not expected (writers per slot are one member's own requests).
  // Throwing leaves a webhook delivery unprocessed so Stripe redelivers it; nothing is lost
  // (the Payment row is already recorded; the slot promotion completes on redelivery).
  throw new Error(`Day Pass ${dayPassId}: activation lost ${MAX_ACTIVATION_ATTEMPTS} consecutive races`);
}

function logActivationAnomalies(
  logger: Logger,
  fields: Record<string, unknown>,
  pi: SucceededPaymentIntentSnapshot,
  dayPass: { status: DayPassStatus; priceCents: number; stripePaymentIntentId: string | null },
  isCurrentIntent: boolean,
  isPreviousIntent: boolean,
): void {
  if (pi.amount !== null && pi.amount !== dayPass.priceCents) {
    // Money moved for a different amount than the slot's snapshot (price rotated mid-attempt).
    // Entitlement still follows the payment; the Payment row records what was really charged.
    logDayPassEvent(
      logger,
      'DAY_PASS_PAYMENT_SUCCEEDED',
      { ...fields, reason: 'amount_differs_from_slot', slotPriceCents: dayPass.priceCents },
      'warn',
    );
  }
  if (isPreviousIntent && !isCurrentIntent) {
    // A replaced intent was paid after all (its cancellation failed or raced). Honour the
    // payment; if the slot is already ACTIVE on another intent this is a double charge that
    // reconciliation must surface for a refund — never silently drop the record.
    logDayPassEvent(
      logger,
      'DAY_PASS_PAYMENT_SUCCEEDED',
      {
        ...fields,
        reason: dayPass.status === DayPassStatus.ACTIVE ? 'double_payment_suspected' : 'previous_intent_paid',
        currentIntent: dayPass.stripePaymentIntentId,
      },
      'error',
    );
  }
  if (dayPass.status === DayPassStatus.EXPIRED) {
    logDayPassEvent(logger, 'DAY_PASS_PAYMENT_SUCCEEDED', { ...fields, reason: 'late_success_on_expired_attempt' }, 'warn');
  }
}
