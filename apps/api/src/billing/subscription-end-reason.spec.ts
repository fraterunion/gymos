import { SubscriptionEndReason } from '@prisma/client';
import { classifyEndReason, describeEndReason, expectedEndReasonFromStripe, resolveStripeEndReason } from './subscription-end-reason';

describe('subscription-end-reason — Stripe facts → recorded reason', () => {
  it('maps failed collection, disputes and never-paid first invoices to involuntary reasons', () => {
    expect(resolveStripeEndReason({ status: 'canceled', cancellationReason: 'payment_failed' }, { pendingCashSuccessor: false })).toBe(SubscriptionEndReason.PAYMENT_FAILED);
    expect(resolveStripeEndReason({ status: 'canceled', cancellationReason: 'payment_disputed' }, { pendingCashSuccessor: false })).toBe(SubscriptionEndReason.PAYMENT_DISPUTED);
    expect(resolveStripeEndReason({ status: 'incomplete_expired', cancellationReason: null }, { pendingCashSuccessor: false })).toBe(SubscriptionEndReason.INCOMPLETE_EXPIRED);
  });

  it('a requested cancellation stays MEMBER_CANCELLED — Stripe does not say who requested it, and GymOS never invents an actor', () => {
    expect(resolveStripeEndReason({ status: 'canceled', cancellationReason: 'cancellation_requested' }, { pendingCashSuccessor: false })).toBe(SubscriptionEndReason.MEMBER_CANCELLED);
    expect(resolveStripeEndReason({ status: 'canceled', cancellationReason: null }, { pendingCashSuccessor: false })).toBe(SubscriptionEndReason.MEMBER_CANCELLED);
    expect(expectedEndReasonFromStripe({ status: 'canceled', cancellationReason: 'cancellation_requested' })).toBeNull();
  });

  it('a scheduled cash successor keeps the existing payment-method supersession semantics', () => {
    expect(resolveStripeEndReason({ status: 'canceled', cancellationReason: 'payment_failed' }, { pendingCashSuccessor: true })).toBe(SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD);
  });

  it('classifies voluntary vs involuntary vs supersession for analytics', () => {
    expect(classifyEndReason(SubscriptionEndReason.MEMBER_CANCELLED)).toBe('VOLUNTARY');
    expect(classifyEndReason(SubscriptionEndReason.STAFF_CANCELLED)).toBe('VOLUNTARY');
    expect(classifyEndReason(SubscriptionEndReason.PAYMENT_FAILED)).toBe('INVOLUNTARY');
    expect(classifyEndReason(SubscriptionEndReason.PAYMENT_DISPUTED)).toBe('INVOLUNTARY');
    expect(classifyEndReason(SubscriptionEndReason.INCOMPLETE_EXPIRED)).toBe('INVOLUNTARY');
    expect(classifyEndReason(SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE)).toBe('SUPERSEDED');
    expect(classifyEndReason(null)).toBe('UNKNOWN');
  });

  it('describes every reason in operator Spanish', () => {
    for (const reason of Object.values(SubscriptionEndReason)) {
      expect(describeEndReason(reason)).not.toBe('Motivo no registrado');
    }
    expect(describeEndReason(SubscriptionEndReason.PAYMENT_FAILED)).toBe('Cancelada por falta de pago');
    expect(describeEndReason(null)).toBe('Motivo no registrado');
  });
});
