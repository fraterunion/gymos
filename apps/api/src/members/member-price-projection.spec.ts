import { effectiveSubscriptionPriceCents } from '../memberships/subscription-price';

/**
 * Documents the Member 360 / mobile projection contract used after the
 * Full Access catalog rose 1500 → 1700 FUTURE_ONLY.
 */
describe('member price projection contract', () => {
  const catalog1700 = 170_000;

  it('existing Full Access lock stays 1500 in API plan.priceCents after catalog 1700', () => {
    const subscription = { priceCents: 150_000 };
    const membershipPlan = { priceCents: catalog1700 };
    const projected = {
      priceCents: effectiveSubscriptionPriceCents({
        subscriptionPriceCents: subscription.priceCents,
        catalogPriceCents: membershipPlan.priceCents,
      }),
      catalogPriceCents: membershipPlan.priceCents,
    };
    expect(projected.priceCents).toBe(150_000);
    expect(projected.catalogPriceCents).toBe(170_000);
  });

  it('new Full Access membership after cutoff projects catalog 1700', () => {
    const subscription = { priceCents: 170_000 };
    const membershipPlan = { priceCents: catalog1700 };
    expect(
      effectiveSubscriptionPriceCents({
        subscriptionPriceCents: subscription.priceCents,
        catalogPriceCents: membershipPlan.priceCents,
      }),
    ).toBe(170_000);
  });

  it('renewal display for a grandfathered member stays 1500', () => {
    const renewalDisplayCents = effectiveSubscriptionPriceCents({
      subscriptionPriceCents: 150_000,
      catalogPriceCents: catalog1700,
    });
    expect(renewalDisplayCents).toBe(150_000);
  });

  it('custom negotiated 1400 is preserved under catalog 1700', () => {
    expect(
      effectiveSubscriptionPriceCents({
        subscriptionPriceCents: 140_000,
        catalogPriceCents: catalog1700,
      }),
    ).toBe(140_000);
  });

  it('other plans with matching lock/catalog remain unaffected', () => {
    expect(
      effectiveSubscriptionPriceCents({
        subscriptionPriceCents: 80_000,
        catalogPriceCents: 80_000,
      }),
    ).toBe(80_000);
  });
});
