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
