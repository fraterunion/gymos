import { SubscriptionEndReason } from '@prisma/client';

/**
 * Cancellation-reason accuracy. Stripe is the only source that knows WHY a subscription it
 * ended actually ended: `cancellation_details.reason` is `payment_failed`, `payment_disputed`
 * or `cancellation_requested`, and an unpaid first invoice ends as `incomplete_expired`.
 * `cancellation_requested` does not say who clicked (member portal vs Stripe Dashboard), so it
 * stays MEMBER_CANCELLED: a *request*, never a failure. GymOS never invents an actor.
 */
export type StripeTerminalFacts = {
  /** Stripe subscription status at the time it ended (`canceled` | `incomplete_expired`). */
  status: string;
  cancellationReason: string | null;
};

export const INVOLUNTARY_END_REASONS: readonly SubscriptionEndReason[] = [
  SubscriptionEndReason.PAYMENT_FAILED,
  SubscriptionEndReason.PAYMENT_DISPUTED,
  SubscriptionEndReason.INCOMPLETE_EXPIRED,
];

export const VOLUNTARY_END_REASONS: readonly SubscriptionEndReason[] = [
  SubscriptionEndReason.MEMBER_CANCELLED,
  SubscriptionEndReason.STAFF_CANCELLED,
];

export const SUPERSESSION_END_REASONS: readonly SubscriptionEndReason[] = [
  SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD,
  SubscriptionEndReason.SUPERSEDED_RENEWAL,
  SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE,
];

export type EndReasonClass = 'VOLUNTARY' | 'INVOLUNTARY' | 'SUPERSEDED' | 'UNKNOWN';

export function classifyEndReason(reason: SubscriptionEndReason | null | undefined): EndReasonClass {
  if (!reason) return 'UNKNOWN';
  if (INVOLUNTARY_END_REASONS.includes(reason)) return 'INVOLUNTARY';
  if (VOLUNTARY_END_REASONS.includes(reason)) return 'VOLUNTARY';
  if (SUPERSESSION_END_REASONS.includes(reason)) return 'SUPERSEDED';
  return 'UNKNOWN';
}

/**
 * The end reason Stripe's own facts imply. `null` when Stripe gives no signal beyond "a
 * cancellation was requested" — then member vs staff cannot be told apart from Stripe alone.
 */
export function expectedEndReasonFromStripe(facts: StripeTerminalFacts): SubscriptionEndReason | null {
  if (facts.status === 'incomplete_expired') return SubscriptionEndReason.INCOMPLETE_EXPIRED;
  switch (facts.cancellationReason) {
    case 'payment_failed':
      return SubscriptionEndReason.PAYMENT_FAILED;
    case 'payment_disputed':
      return SubscriptionEndReason.PAYMENT_DISPUTED;
    default:
      return null;
  }
}

/**
 * What the `customer.subscription.deleted` handler records on a row that has no end reason yet.
 * A scheduled cash successor keeps its existing precedence: the membership continues offline, so
 * the Stripe row ended because the payment method changed, whatever Stripe's own reason says.
 */
export function resolveStripeEndReason(
  facts: StripeTerminalFacts,
  opts: { pendingCashSuccessor: boolean },
): SubscriptionEndReason {
  if (opts.pendingCashSuccessor) return SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD;
  return expectedEndReasonFromStripe(facts) ?? SubscriptionEndReason.MEMBER_CANCELLED;
}

/** The four values added by migration 20261008200000; unknown to the previous API build's Prisma client. */
export const END_REASON_V2_VALUES: readonly SubscriptionEndReason[] = [
  SubscriptionEndReason.PAYMENT_FAILED,
  SubscriptionEndReason.PAYMENT_DISPUTED,
  SubscriptionEndReason.INCOMPLETE_EXPIRED,
  SubscriptionEndReason.STAFF_CANCELLED,
];

/**
 * Expand-and-contract gate for the new enum values. The previous API build's Prisma client throws
 * on any read that returns a row holding one of them ("Value … not found in enum"), which would
 * break member lists and Member 360 for that member after a rollback. So the schema ships first
 * (expand) and the new values are only WRITTEN once `BILLING_END_REASON_V2=true` is set
 * deliberately, after the rollback window. Default: off (legacy values are written, old build
 * stays runnable). Reads, analytics and detectors accept both at all times.
 */
export function involuntaryEndReasonsEnabled(): boolean {
  return process.env['BILLING_END_REASON_V2'] === 'true';
}

/** The value to persist for `reason` under the current compatibility mode. */
export function recordableEndReason(reason: SubscriptionEndReason): SubscriptionEndReason {
  if (involuntaryEndReasonsEnabled()) return reason;
  return END_REASON_V2_VALUES.includes(reason) ? SubscriptionEndReason.MEMBER_CANCELLED : reason;
}

/** Operator-facing Spanish label. */
export function describeEndReason(reason: SubscriptionEndReason | null | undefined): string {
  switch (reason) {
    case SubscriptionEndReason.MEMBER_CANCELLED:
      return 'Cancelación solicitada';
    case SubscriptionEndReason.STAFF_CANCELLED:
      return 'Cancelada por el staff';
    case SubscriptionEndReason.PAYMENT_FAILED:
      return 'Cancelada por falta de pago';
    case SubscriptionEndReason.PAYMENT_DISPUTED:
      return 'Cancelada por disputa de pago';
    case SubscriptionEndReason.INCOMPLETE_EXPIRED:
      return 'Nunca inició: primer cobro no completado';
    case SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD:
      return 'Reemplazada: cambio de método de pago';
    case SubscriptionEndReason.SUPERSEDED_RENEWAL:
      return 'Reemplazada: renovación';
    case SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE:
      return 'Reemplazada: cambio de plan';
    default:
      return 'Motivo no registrado';
  }
}
