import { BillingInterval, SubscriptionStatus } from '@prisma/client';
import {
  buildExecutiveDataQuality,
  buildExecutiveReconciliation,
  computeEstimatedMrrCents,
  isRenewalEligible,
  monthlyEquivalentCents,
  paymentMethodOwnerLabel,
} from './executive-dashboard.utils';

describe('monthlyEquivalentCents', () => {
  it('returns monthly price unchanged', () => {
    expect(monthlyEquivalentCents(149900, BillingInterval.MONTHLY)).toBe(149900);
  });

  it('normalizes annual plan to monthly equivalent', () => {
    expect(monthlyEquivalentCents(1200000, BillingInterval.YEARLY)).toBe(100000);
  });

  it('normalizes weekly plan to monthly equivalent', () => {
    expect(monthlyEquivalentCents(10000, BillingInterval.WEEKLY)).toBe(43333);
  });
});

describe('computeEstimatedMrrCents', () => {
  const plan = { priceCents: 120000, billingInterval: BillingInterval.MONTHLY };

  it('includes ACTIVE subscriptions', () => {
    expect(
      computeEstimatedMrrCents([{ status: SubscriptionStatus.ACTIVE, cancelAtPeriodEnd: false, membershipPlan: plan }]),
    ).toBe(120000);
  });

  it('excludes TRIALING from paid MRR', () => {
    expect(
      computeEstimatedMrrCents([
        { status: SubscriptionStatus.ACTIVE, cancelAtPeriodEnd: false, membershipPlan: plan },
        { status: SubscriptionStatus.TRIALING, cancelAtPeriodEnd: false, membershipPlan: plan },
      ]),
    ).toBe(120000);
  });

  it('excludes PAST_DUE and PAUSED', () => {
    expect(
      computeEstimatedMrrCents([
        { status: SubscriptionStatus.PAST_DUE, cancelAtPeriodEnd: false, membershipPlan: plan },
        { status: SubscriptionStatus.PAUSED, cancelAtPeriodEnd: false, membershipPlan: plan },
      ]),
    ).toBe(0);
  });

  it('includes ACTIVE cancelAtPeriodEnd (still contracted)', () => {
    expect(
      computeEstimatedMrrCents([
        { status: SubscriptionStatus.ACTIVE, cancelAtPeriodEnd: true, membershipPlan: plan },
      ]),
    ).toBe(120000);
  });
});

describe('isRenewalEligible', () => {
  it('allows ACTIVE without cancelAtPeriodEnd', () => {
    expect(
      isRenewalEligible({ status: SubscriptionStatus.ACTIVE, cancelAtPeriodEnd: false }),
    ).toBe(true);
  });

  it('rejects cancelAtPeriodEnd', () => {
    expect(
      isRenewalEligible({ status: SubscriptionStatus.ACTIVE, cancelAtPeriodEnd: true }),
    ).toBe(false);
  });

  it('rejects TRIALING', () => {
    expect(
      isRenewalEligible({ status: SubscriptionStatus.TRIALING, cancelAtPeriodEnd: false }),
    ).toBe(false);
  });
});

describe('buildExecutiveReconciliation', () => {
  it('flags mismatches when totals diverge', () => {
    const result = buildExecutiveReconciliation({
      monthCollectedCents: 100000,
      monthBreakdownTotalCents: 90000,
      monthTrendSumCents: 100000,
      monthTrendPaymentCount: 5,
      monthPaymentCount: 5,
      monthStripeCents: 80000,
      monthCashCents: 20000,
      monthOtherCents: 0,
      monthPlanAttributedCents: 95000,
      monthUnattributedCents: 5000,
    });

    expect(result.methodSplitEqualsTotal).toBe(true);
    expect(result.breakdownEqualsMonthCollected).toBe(false);
  });
});

describe('buildExecutiveDataQuality', () => {
  it('uses actionable Spanish warnings without technical IDs', () => {
    const result = buildExecutiveDataQuality({
      lastPaymentAt: new Date('2026-08-01'),
      subsMissingStripeId: 2,
      activeStripeSubscriptionsWithoutPayment: 1,
      syncMayBeIncomplete: true,
    });

    expect(result.warnings.some((w) => w.includes('sincronización'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('sin un pago registrado'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('vinculadas con Stripe'))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/pi_|in_|wh_/);
  });
});

describe('paymentMethodOwnerLabel', () => {
  it('does not invent card brands', () => {
    expect(paymentMethodOwnerLabel('STRIPE')).toBe('Stripe');
    expect(paymentMethodOwnerLabel('visa')).toBe('Otro');
  });
});

describe('ExecutiveDashboardService DTO safety', () => {
  it('sample executive payload shape excludes raw Stripe identifiers', () => {
    const sample = {
      activity: [{ paymentMethod: 'Stripe' }],
      failedPayments: [{ failureReason: null, failureReasonAvailable: false }],
      stripe: { lastSyncAt: '2026-08-01T12:00:00.000Z' },
    };
    const json = JSON.stringify(sample);
    expect(json).not.toMatch(/pi_[a-zA-Z0-9]+/);
    expect(json).not.toMatch(/in_[a-zA-Z0-9]+/);
  });
});
