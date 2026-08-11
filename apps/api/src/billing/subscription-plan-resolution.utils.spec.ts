import {
  STRIPE_IMMEDIATE_UPGRADE_PARAMS,
  buildImmediateUpgradeUpdateParams,
  readCurrentStripePriceId,
  readPendingPlanIdFromMetadata,
} from './subscription-plan-resolution.utils';

describe('subscription-plan-resolution.utils', () => {
  it('builds immediate upgrade params with always_invoice + pending_if_incomplete', () => {
    const params = buildImmediateUpgradeUpdateParams({
      subscriptionItemId: 'si_1',
      newPriceId: 'price_full',
      metadata: { userId: 'u1', studioId: 's1', planId: 'plan-full' },
    });

    expect(params).toEqual({
      cancel_at_period_end: false,
      items: [{ id: 'si_1', price: 'price_full' }],
      metadata: { userId: 'u1', studioId: 's1', planId: 'plan-full' },
      ...STRIPE_IMMEDIATE_UPGRADE_PARAMS,
    });
    expect(STRIPE_IMMEDIATE_UPGRADE_PARAMS.proration_behavior).toBe('always_invoice');
    expect(STRIPE_IMMEDIATE_UPGRADE_PARAMS.payment_behavior).toBe('pending_if_incomplete');
  });

  it('reads current stripe price id from subscription items', () => {
    expect(
      readCurrentStripePriceId({
        items: { data: [{ price: { id: 'price_basic' } }] },
      }),
    ).toBe('price_basic');
  });

  it('reads pending plan id from metadata', () => {
    expect(readPendingPlanIdFromMetadata({ pendingPlanId: 'plan-basic' })).toBe('plan-basic');
    expect(readPendingPlanIdFromMetadata({ planId: 'plan-full' })).toBeNull();
  });
});
