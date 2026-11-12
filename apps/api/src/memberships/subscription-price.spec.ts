import {
  MissingSubscriptionPriceLockError,
  effectiveSubscriptionPriceCents,
  isGrandfatheredBelowCatalog,
  resolveAuthorizedSalePriceCents,
  resolveStampedSalePriceCents,
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

describe('resolveAuthorizedSalePriceCents / resolveStampedSalePriceCents', () => {
  const catalog1700 = 170_000;
  const lock1500 = 150_000;

  it('new cash sale with no held subscription authorizes and stamps catalog 1700', () => {
    expect(
      resolveAuthorizedSalePriceCents({
        heldSubscription: null,
        catalogPriceCents: catalog1700,
      }),
    ).toBe(catalog1700);
    expect(
      resolveStampedSalePriceCents({
        heldSubscription: null,
        catalogPriceCents: catalog1700,
        chargedAmountCents: catalog1700,
        ownerOverride: false,
      }),
    ).toBe(catalog1700);
  });

  it('cash renewal of a grandfathered Full Access member authorizes and stamps 1500', () => {
    const held = { priceCents: lock1500 };
    expect(
      resolveAuthorizedSalePriceCents({
        heldSubscription: held,
        catalogPriceCents: catalog1700,
      }),
    ).toBe(lock1500);
    expect(
      resolveStampedSalePriceCents({
        heldSubscription: held,
        catalogPriceCents: catalog1700,
        chargedAmountCents: lock1500,
        ownerOverride: false,
      }),
    ).toBe(lock1500);
  });

  it('refuses to authorize catalog when an existing membership has a missing lock', () => {
    expect(() =>
      resolveAuthorizedSalePriceCents({
        heldSubscription: { priceCents: null },
        catalogPriceCents: catalog1700,
      }),
    ).toThrow(MissingSubscriptionPriceLockError);
  });

  it('refuses to stamp catalog when an existing membership has a missing lock', () => {
    expect(() =>
      resolveStampedSalePriceCents({
        heldSubscription: { priceCents: null },
        catalogPriceCents: catalog1700,
        chargedAmountCents: catalog1700,
        ownerOverride: false,
      }),
    ).toThrow(MissingSubscriptionPriceLockError);
  });

  it('owner override on a missing lock stamps the charged amount, never catalog by default', () => {
    expect(
      resolveStampedSalePriceCents({
        heldSubscription: { priceCents: null },
        catalogPriceCents: catalog1700,
        chargedAmountCents: lock1500,
        ownerOverride: true,
      }),
    ).toBe(lock1500);
  });

  it('owner amount override on a locked membership preserves the existing lock stamp', () => {
    expect(
      resolveStampedSalePriceCents({
        heldSubscription: { priceCents: lock1500 },
        catalogPriceCents: catalog1700,
        chargedAmountCents: 140_000,
        ownerOverride: true,
      }),
    ).toBe(lock1500);
  });
});
