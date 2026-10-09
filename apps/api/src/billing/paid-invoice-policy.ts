import { SubscriptionEndReason, SubscriptionStatus } from '@prisma/client';
import { isTerminalStripeStatus } from './stale-subscription-event';
import { SUPERSESSION_END_REASONS } from './subscription-end-reason';

/**
 * Late-payment policy for `invoice.paid`. The money is always recorded (the Payment row is written
 * before this runs); what this decides is whether the paid period may become ENTITLEMENT, and
 * whether an operator must look at it. Ambiguity never resolves to "grant", "refund" or
 * "reactivate" on its own: it becomes a durable reconciliation case.
 *
 * Scenarios (the letters match the billing-reliability brief):
 *   A active subscription · B scheduled to cancel · C already ended · D previously failed invoice
 *   E superseded membership · F after a plan change · G fixed-duration · H monthly
 *   I refunded/disputed (handled by charge.* events, not here) · J already processed
 */
export type PaidInvoiceSubscriptionFacts = {
  id: string;
  status: SubscriptionStatus;
  endReason: SubscriptionEndReason | null;
  supersededBySubscriptionId: string | null;
  cancelAtPeriodEnd: boolean;
  /** Plans with `entitlementDays` grant explicit paid windows (cycles); monthly plans do not. */
  isFixedDuration: boolean;
  /**
   * When the membership ended (the stored `customer.subscription.deleted` event, else the row's
   * last write). A payment made before this instant was made while the membership was live.
   */
  endedAt: Date | null;
};

export type PaidInvoiceFacts = {
  invoiceId: string;
  amountPaidCents: number;
  billingReason: string | null;
  /** Stripe's `status_transitions.paid_at`; null when the payload carries none. */
  paidAt: Date | null;
  subscription: PaidInvoiceSubscriptionFacts | null;
  /**
   * Stripe's current status for the subscription, fetched only when the local row is terminal.
   * `null` = not consulted; `'unavailable'` = the lookup failed.
   */
  liveStripeStatus: string | 'unavailable' | null;
  /** The Payment row for this invoice already read SUCCEEDED before this delivery. */
  paymentAlreadySucceeded: boolean;
  /** The Payment row for this invoice previously read FAILED. */
  paymentPreviouslyFailed: boolean;
  /**
   * The member already holds another renewable or currently-entitled membership in the same plan
   * family (e.g. a cash Booty Lab sold after Stripe canceled the card one). A late payment on the
   * ended row would then double-cover a period someone already paid for.
   */
  entitledSiblingExists?: boolean;
};

export type PaidInvoiceReasonCode =
  | 'SUBSCRIPTION_ENDED'
  | 'LOCAL_CANCELED_STRIPE_ALIVE'
  | 'SUPERSEDED_MEMBERSHIP'
  | 'NO_LOCAL_SUBSCRIPTION'
  | 'LATE_FIXED_WINDOW_GRANTED'
  | 'DUPLICATE_MEMBERSHIP_PAYMENT';

export type PaidInvoiceDecision = {
  scenario: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'J' | 'UNATTRIBUTED';
  /** Whether the fixed-duration grant path may run for this invoice. */
  allowEntitlementGrant: boolean;
  /** When set, a reconciliation case must be observed with this severity/reason. */
  exception: {
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    reasonCode: PaidInvoiceReasonCode;
    /** True when the member paid and has NO access as a result of this invoice. */
    paidWithoutAccess: boolean;
    explanation: string;
  } | null;
};

const RENEWAL_BILLING_REASONS: ReadonlySet<string> = new Set(['subscription_cycle', 'subscription_update']);

export function isSupersededSubscription(sub: Pick<PaidInvoiceSubscriptionFacts, 'endReason' | 'supersededBySubscriptionId'>): boolean {
  return sub.supersededBySubscriptionId !== null || (sub.endReason !== null && SUPERSESSION_END_REASONS.includes(sub.endReason));
}

export function decidePaidInvoice(facts: PaidInvoiceFacts): PaidInvoiceDecision {
  const sub = facts.subscription;

  if (!sub) {
    // A first-purchase invoice can legitimately race ahead of customer.subscription.created; the
    // nightly detector catches anything that stays unattributed. A RENEWAL invoice with no local
    // row is not a race: the member keeps paying for a membership GymOS does not know about.
    const renewal = facts.billingReason !== null && RENEWAL_BILLING_REASONS.has(facts.billingReason);
    return {
      scenario: 'UNATTRIBUTED',
      allowEntitlementGrant: true,
      exception: renewal
        ? {
            severity: 'CRITICAL',
            reasonCode: 'NO_LOCAL_SUBSCRIPTION',
            paidWithoutAccess: true,
            explanation: 'Stripe cobró una renovación de una suscripción que no existe en GymOS.',
          }
        : null,
    };
  }

  if (isSupersededSubscription(sub)) {
    // E — the membership this invoice belongs to was replaced (cash successor, renewal row, plan
    // change). Granting here would double-cover a period another row already honours. Checked
    // before J so a redelivery can never slip a grant past the supersession.
    return {
      scenario: 'E',
      allowEntitlementGrant: false,
      exception: {
        severity: 'CRITICAL',
        reasonCode: 'SUPERSEDED_MEMBERSHIP',
        paidWithoutAccess: true,
        explanation: 'Stripe cobró una membresía que GymOS ya reemplazó por otra; el cobro no otorgó vigencia.',
      },
    };
  }

  if (facts.paymentAlreadySucceeded) {
    // J — idempotent redelivery: the grant path is itself idempotent (one cycle per invoice).
    return { scenario: 'J', allowEntitlementGrant: true, exception: null };
  }

  if (sub.status === SubscriptionStatus.CANCELED) {
    // A payment made while the membership was still live (a replayed or late-delivered
    // invoice.paid for a period the member already consumed) is ordinary, not a late payment.
    const paidWhileLive = facts.paidAt !== null && sub.endedAt !== null && facts.paidAt.getTime() <= sub.endedAt.getTime();
    if (paidWhileLive) {
      return { scenario: sub.isFixedDuration ? 'G' : 'H', allowEntitlementGrant: true, exception: null };
    }
    const stripeAlive = facts.liveStripeStatus !== null && facts.liveStripeStatus !== 'unavailable' && !isTerminalStripeStatus(facts.liveStripeStatus);
    if (facts.entitledSiblingExists) {
      // The member is already covered by a newer membership of the same family: this payment
      // bought the same period twice. Never a second window; an operator decides on the refund.
      return {
        scenario: 'C',
        allowEntitlementGrant: false,
        exception: {
          severity: 'CRITICAL',
          reasonCode: 'DUPLICATE_MEMBERSHIP_PAYMENT',
          paidWithoutAccess: true,
          explanation: 'Stripe cobró una suscripción cancelada mientras el miembro ya tiene otra membresía vigente del mismo tipo: posible cobro doble; no se otorgó vigencia adicional.',
        },
      };
    }
    if (sub.isFixedDuration) {
      // G+C — a fixed-duration invoice names its exact paid window; honouring that window is not
      // a guess, and it does NOT reactivate the subscription (the row stays CANCELED and simply
      // carries the paid window). Visible, not silent.
      return {
        scenario: 'C',
        allowEntitlementGrant: true,
        exception: {
          severity: stripeAlive ? 'HIGH' : 'MEDIUM',
          reasonCode: stripeAlive ? 'LOCAL_CANCELED_STRIPE_ALIVE' : 'LATE_FIXED_WINDOW_GRANTED',
          paidWithoutAccess: false,
          explanation: stripeAlive
            ? 'GymOS tiene la suscripción cancelada pero Stripe la mantiene vigente; la vigencia pagada se otorgó.'
            : 'Stripe cobró una factura de una suscripción ya cancelada; se otorgó solo la vigencia pagada y no se reactivó la suscripción.',
        },
      };
    }
    // H+C — a monthly row has no paid-window ledger: a canceled subscription cannot carry access.
    return {
      scenario: 'C',
      allowEntitlementGrant: false,
      exception: {
        severity: 'CRITICAL',
        reasonCode: stripeAlive ? 'LOCAL_CANCELED_STRIPE_ALIVE' : 'SUBSCRIPTION_ENDED',
        paidWithoutAccess: true,
        explanation: stripeAlive
          ? 'Stripe cobró y mantiene la suscripción vigente, pero GymOS la tiene cancelada: el miembro pagó y no tiene acceso.'
          : 'Stripe cobró una factura de una suscripción ya terminada: el dinero se registró, pero no se restauró el acceso.',
      },
    };
  }

  if (sub.cancelAtPeriodEnd) {
    // B — paying the current period of a membership that ends later is the normal path.
    return { scenario: 'B', allowEntitlementGrant: true, exception: null };
  }
  if (sub.status === SubscriptionStatus.PAST_DUE && facts.paymentPreviouslyFailed) {
    // D — Stripe recovered a failed invoice; customer.subscription.updated restores ACTIVE.
    return { scenario: 'D', allowEntitlementGrant: true, exception: null };
  }
  if (facts.billingReason === 'subscription_update') {
    // F — proration / plan change on the same Stripe subscription.
    return { scenario: 'F', allowEntitlementGrant: true, exception: null };
  }
  return { scenario: sub.isFixedDuration ? 'G' : 'H', allowEntitlementGrant: true, exception: null };
}
