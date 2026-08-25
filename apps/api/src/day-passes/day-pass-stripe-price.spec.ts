import {
  dayPassFinancialIdentityChanged,
  dayPassSalePriceIdempotencyKey,
  stripePriceMatchesDayPass,
} from './day-pass-stripe-price';

describe('day-pass-stripe-price helpers', () => {
  it('detects financial identity changes', () => {
    expect(
      dayPassFinancialIdentityChanged(
        { priceCents: 20000, currency: 'mxn' },
        { priceCents: 20000, currency: 'mxn' },
      ),
    ).toBe(false);
    expect(
      dayPassFinancialIdentityChanged(
        { priceCents: 20000, currency: 'mxn' },
        { priceCents: 35000, currency: 'mxn' },
      ),
    ).toBe(true);
    expect(
      dayPassFinancialIdentityChanged(
        { priceCents: 20000, currency: 'mxn' },
        { priceCents: 20000, currency: 'usd' },
      ),
    ).toBe(true);
  });

  it('builds deterministic one-time idempotency keys', () => {
    expect(dayPassSalePriceIdempotencyKey('settings-1', { priceCents: 35000, currency: 'mxn' })).toBe(
      'day-pass-price:settings-1:35000:mxn',
    );
  });

  it('matches healthy one-time Stripe prices', () => {
    expect(
      stripePriceMatchesDayPass(
        { unit_amount: 20000, currency: 'mxn', active: true, recurring: null },
        { priceCents: 20000, currency: 'mxn' },
      ),
    ).toEqual({ ok: true });
  });

  it('rejects recurring Stripe prices for Day Pass', () => {
    expect(
      stripePriceMatchesDayPass(
        {
          unit_amount: 20000,
          currency: 'mxn',
          active: true,
          recurring: { interval: 'month' },
        },
        { priceCents: 20000, currency: 'mxn' },
      ).ok,
    ).toBe(false);
  });
});
