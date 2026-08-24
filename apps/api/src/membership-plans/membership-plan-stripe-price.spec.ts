import {
  planFinancialIdentityChanged,
  planSalePriceIdempotencyKey,
  planStripeRecurring,
  stripePriceMatchesPlan,
} from './membership-plan-stripe-price';

describe('membership-plan-stripe-price helpers', () => {
  it('detects financial identity changes', () => {
    const base = {
      priceCents: 130000,
      currency: 'mxn',
      billingInterval: 'MONTHLY' as const,
      entitlementDays: null,
    };
    expect(planFinancialIdentityChanged(base, base)).toBe(false);
    expect(
      planFinancialIdentityChanged(base, { ...base, priceCents: 100000 }),
    ).toBe(true);
    expect(
      planFinancialIdentityChanged(base, { ...base, currency: 'MXN' }),
    ).toBe(false);
    expect(
      planFinancialIdentityChanged(base, { ...base, entitlementDays: 45 }),
    ).toBe(true);
  });

  it('builds stable idempotency keys', () => {
    expect(
      planSalePriceIdempotencyKey('plan-1', {
        priceCents: 100000,
        currency: 'MXN',
        billingInterval: 'MONTHLY',
        entitlementDays: null,
      }),
    ).toBe('plan-price:plan-1:100000:mxn:month:1');
  });

  it('maps entitlementDays plans to day interval', () => {
    expect(
      planStripeRecurring({ billingInterval: 'MONTHLY', entitlementDays: 45 }),
    ).toEqual({ interval: 'day', intervalCount: 45 });
  });

  it('matches Stripe Price against plan sale config', () => {
    const plan = {
      priceCents: 100000,
      currency: 'mxn',
      billingInterval: 'MONTHLY' as const,
      entitlementDays: null,
    };
    expect(
      stripePriceMatchesPlan(
        {
          unit_amount: 100000,
          currency: 'mxn',
          active: true,
          recurring: { interval: 'month', interval_count: 1 },
        },
        plan,
      ),
    ).toEqual({ ok: true });
    expect(
      stripePriceMatchesPlan(
        {
          unit_amount: 130000,
          currency: 'mxn',
          active: true,
          recurring: { interval: 'month', interval_count: 1 },
        },
        plan,
      ),
    ).toEqual({ ok: false, reason: 'amount' });
  });
});
