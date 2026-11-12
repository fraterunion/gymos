import {
  effectiveSubscriptionPriceCents,
  isGrandfatheredBelowCatalog,
} from './subscription-price';

describe('subscription-price', () => {
  it('keeps a locked Full Access price at 1500 after catalog rises to 1700', () => {
    expect(
      effectiveSubscriptionPriceCents({
        subscriptionPriceCents: 150_000,
        catalogPriceCents: 170_000,
      }),
    ).toBe(150_000);
  });

  it('uses catalog 1700 for a new membership with no lock yet', () => {
    expect(
      effectiveSubscriptionPriceCents({
        subscriptionPriceCents: null,
        catalogPriceCents: 170_000,
      }),
    ).toBe(170_000);
  });

  it('preserves an explicit custom negotiated lock above or below catalog', () => {
    expect(
      effectiveSubscriptionPriceCents({
        subscriptionPriceCents: 140_000,
        catalogPriceCents: 170_000,
      }),
    ).toBe(140_000);
    expect(
      effectiveSubscriptionPriceCents({
        subscriptionPriceCents: 180_000,
        catalogPriceCents: 170_000,
      }),
    ).toBe(180_000);
  });

  it('does not treat other plans as grandfathered when lock equals catalog', () => {
    expect(
      isGrandfatheredBelowCatalog({
        subscriptionPriceCents: 80_000,
        catalogPriceCents: 80_000,
      }),
    ).toBe(false);
  });

  it('flags grandfathered Full Access below catalog', () => {
    expect(
      isGrandfatheredBelowCatalog({
        subscriptionPriceCents: 150_000,
        catalogPriceCents: 170_000,
      }),
    ).toBe(true);
  });
});
