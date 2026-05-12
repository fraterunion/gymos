import { SubscriptionStatus } from '@prisma/client';
import { mapStripeSubscriptionStatus } from './stripe-subscription-status';

describe('mapStripeSubscriptionStatus', () => {
  it('maps core Stripe statuses', () => {
    expect(mapStripeSubscriptionStatus('active')).toBe(SubscriptionStatus.ACTIVE);
    expect(mapStripeSubscriptionStatus('trialing')).toBe(SubscriptionStatus.TRIALING);
    expect(mapStripeSubscriptionStatus('past_due')).toBe(SubscriptionStatus.PAST_DUE);
    expect(mapStripeSubscriptionStatus('canceled')).toBe(SubscriptionStatus.CANCELED);
    expect(mapStripeSubscriptionStatus('unpaid')).toBe(SubscriptionStatus.PAST_DUE);
    expect(mapStripeSubscriptionStatus('incomplete')).toBe(SubscriptionStatus.PAUSED);
    expect(mapStripeSubscriptionStatus('incomplete_expired')).toBe(SubscriptionStatus.CANCELED);
    expect(mapStripeSubscriptionStatus('paused')).toBe(SubscriptionStatus.PAUSED);
  });
});
