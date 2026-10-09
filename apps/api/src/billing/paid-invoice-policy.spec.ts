import { SubscriptionEndReason, SubscriptionStatus } from '@prisma/client';
import { decidePaidInvoice, type PaidInvoiceFacts, type PaidInvoiceSubscriptionFacts } from './paid-invoice-policy';

const ENDED_AT = new Date('2026-09-28T02:14:04.000Z');

function sub(overrides: Partial<PaidInvoiceSubscriptionFacts> = {}): PaidInvoiceSubscriptionFacts {
  return {
    id: 'local_sub',
    status: SubscriptionStatus.ACTIVE,
    endReason: null,
    supersededBySubscriptionId: null,
    cancelAtPeriodEnd: false,
    isFixedDuration: false,
    endedAt: null,
    ...overrides,
  };
}

function facts(overrides: Partial<PaidInvoiceFacts> = {}): PaidInvoiceFacts {
  return {
    invoiceId: 'in_test',
    amountPaidCents: 150000,
    billingReason: 'subscription_cycle',
    paidAt: new Date('2026-10-10T12:00:00.000Z'),
    subscription: sub(),
    liveStripeStatus: null,
    paymentAlreadySucceeded: false,
    paymentPreviouslyFailed: false,
    ...overrides,
  };
}

const canceled = (overrides: Partial<PaidInvoiceSubscriptionFacts> = {}) =>
  sub({ status: SubscriptionStatus.CANCELED, endReason: SubscriptionEndReason.PAYMENT_FAILED, endedAt: ENDED_AT, ...overrides });

describe('paid-invoice-policy — late-payment scenarios', () => {
  it('A/H: an active monthly subscription is the normal path (no case)', () => {
    expect(decidePaidInvoice(facts())).toEqual({ scenario: 'H', allowEntitlementGrant: true, exception: null });
  });

  it('G: an active fixed-duration subscription grants its paid window', () => {
    expect(decidePaidInvoice(facts({ subscription: sub({ isFixedDuration: true }) }))).toEqual({ scenario: 'G', allowEntitlementGrant: true, exception: null });
  });

  it('B: paying the current period of a membership scheduled to cancel is legitimate', () => {
    expect(decidePaidInvoice(facts({ subscription: sub({ cancelAtPeriodEnd: true }) }))).toEqual({ scenario: 'B', allowEntitlementGrant: true, exception: null });
  });

  it('D: a previously failed invoice recovered on a PAST_DUE row is legitimate', () => {
    expect(decidePaidInvoice(facts({ subscription: sub({ status: SubscriptionStatus.PAST_DUE }), paymentPreviouslyFailed: true }))).toEqual({ scenario: 'D', allowEntitlementGrant: true, exception: null });
  });

  it('F: a plan-change invoice on a live subscription is legitimate', () => {
    expect(decidePaidInvoice(facts({ billingReason: 'subscription_update' }))).toEqual({ scenario: 'F', allowEntitlementGrant: true, exception: null });
  });

  it('J: a redelivery for an invoice already recorded as paid changes nothing and opens no case', () => {
    expect(decidePaidInvoice(facts({ paymentAlreadySucceeded: true, subscription: canceled() }))).toEqual({ scenario: 'J', allowEntitlementGrant: true, exception: null });
  });

  it('E beats J: a redelivery for a superseded membership still grants nothing', () => {
    const decision = decidePaidInvoice(facts({ paymentAlreadySucceeded: true, subscription: canceled({ supersededBySubscriptionId: 'cash_successor', endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD }) }));
    expect(decision.scenario).toBe('E');
    expect(decision.allowEntitlementGrant).toBe(false);
  });

  it('C (monthly): a payment after the subscription ended records money, grants nothing, and is CRITICAL', () => {
    const decision = decidePaidInvoice(facts({ subscription: canceled(), liveStripeStatus: 'canceled' }));
    expect(decision.scenario).toBe('C');
    expect(decision.allowEntitlementGrant).toBe(false);
    expect(decision.exception).toMatchObject({ severity: 'CRITICAL', reasonCode: 'SUBSCRIPTION_ENDED', paidWithoutAccess: true });
  });

  it('a replayed invoice for a period paid WHILE the membership was live is ordinary (no cry-wolf CRITICAL)', () => {
    const paidBeforeEnd = new Date('2026-09-14T02:00:00.000Z');
    expect(decidePaidInvoice(facts({ paidAt: paidBeforeEnd, subscription: canceled(), liveStripeStatus: 'canceled' }))).toEqual({ scenario: 'H', allowEntitlementGrant: true, exception: null });
    expect(decidePaidInvoice(facts({ paidAt: paidBeforeEnd, subscription: canceled({ isFixedDuration: true }), liveStripeStatus: 'canceled' }))).toEqual({ scenario: 'G', allowEntitlementGrant: true, exception: null });
    // Without a paid_at or an end instant there is no way to tell: treat as late.
    expect(decidePaidInvoice(facts({ paidAt: null, subscription: canceled(), liveStripeStatus: 'canceled' })).exception?.reasonCode).toBe('SUBSCRIPTION_ENDED');
    expect(decidePaidInvoice(facts({ subscription: canceled({ endedAt: null }), liveStripeStatus: 'canceled' })).exception?.reasonCode).toBe('SUBSCRIPTION_ENDED');
  });

  it('C (monthly, Stripe still alive): GymOS-side cancellation with Stripe billing is CRITICAL with its own reason', () => {
    const decision = decidePaidInvoice(facts({ subscription: canceled({ endReason: SubscriptionEndReason.STAFF_CANCELLED }), liveStripeStatus: 'active' }));
    expect(decision.allowEntitlementGrant).toBe(false);
    expect(decision.exception).toMatchObject({ severity: 'CRITICAL', reasonCode: 'LOCAL_CANCELED_STRIPE_ALIVE', paidWithoutAccess: true });
  });

  it('C (monthly, Stripe unavailable): still never grants and never guesses', () => {
    const decision = decidePaidInvoice(facts({ subscription: canceled(), liveStripeStatus: 'unavailable' }));
    expect(decision.allowEntitlementGrant).toBe(false);
    expect(decision.exception?.reasonCode).toBe('SUBSCRIPTION_ENDED');
  });

  it('C (fixed-duration): the explicit paid window is honoured, the subscription is not reactivated, and it is visible (MEDIUM)', () => {
    const decision = decidePaidInvoice(facts({ subscription: canceled({ isFixedDuration: true }), liveStripeStatus: 'canceled' }));
    expect(decision.allowEntitlementGrant).toBe(true);
    expect(decision.exception).toMatchObject({ severity: 'MEDIUM', reasonCode: 'LATE_FIXED_WINDOW_GRANTED', paidWithoutAccess: false });
  });

  it('C with a newer same-family membership already covering the member: no second window, CRITICAL duplicate payment', () => {
    for (const isFixedDuration of [true, false]) {
      const decision = decidePaidInvoice(facts({ subscription: canceled({ isFixedDuration }), liveStripeStatus: 'canceled', entitledSiblingExists: true }));
      expect(decision.allowEntitlementGrant).toBe(false);
      expect(decision.exception).toMatchObject({ severity: 'CRITICAL', reasonCode: 'DUPLICATE_MEMBERSHIP_PAYMENT', paidWithoutAccess: true });
    }
  });

  it('E: a superseded membership never gets a second entitlement, whatever the plan type', () => {
    for (const isFixedDuration of [true, false]) {
      const decision = decidePaidInvoice(facts({ subscription: canceled({ supersededBySubscriptionId: 'cash_successor', endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD, isFixedDuration }) }));
      expect(decision.scenario).toBe('E');
      expect(decision.allowEntitlementGrant).toBe(false);
      expect(decision.exception).toMatchObject({ severity: 'CRITICAL', reasonCode: 'SUPERSEDED_MEMBERSHIP', paidWithoutAccess: true });
    }
    // endReason alone (no successor link) is enough to count as superseded.
    expect(decidePaidInvoice(facts({ subscription: sub({ status: SubscriptionStatus.ACTIVE, endReason: SubscriptionEndReason.SUPERSEDED_RENEWAL }) })).scenario).toBe('E');
  });

  it('UNATTRIBUTED: a first-purchase invoice racing its subscription row opens no case; a renewal with no local row is CRITICAL', () => {
    expect(decidePaidInvoice(facts({ subscription: null, billingReason: 'subscription_create' }))).toEqual({ scenario: 'UNATTRIBUTED', allowEntitlementGrant: true, exception: null });
    const renewal = decidePaidInvoice(facts({ subscription: null, billingReason: 'subscription_cycle' }));
    expect(renewal.exception).toMatchObject({ severity: 'CRITICAL', reasonCode: 'NO_LOCAL_SUBSCRIPTION', paidWithoutAccess: true });
  });
});
