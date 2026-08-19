import { SubscriptionStatus } from '@prisma/client';
import {
  currentlyEntitledSubscriptionWhere,
  isSubscriptionCurrentlyEntitled,
} from './membership-entitlement';

describe('canonical membership entitlement', () => {
  const end = new Date('2026-08-19T12:00:00.000Z');
  const subscription = {
    status: SubscriptionStatus.ACTIVE,
    currentPeriodEnd: end,
    entitlementEndsAt: null,
  };

  it('allows an ACTIVE recurring subscription before currentPeriodEnd', () => {
    expect(isSubscriptionCurrentlyEntitled(subscription, new Date(end.getTime() - 1))).toBe(true);
  });

  it('denies at the exact currentPeriodEnd boundary', () => {
    expect(isSubscriptionCurrentlyEntitled(subscription, end)).toBe(false);
  });

  it('denies after currentPeriodEnd despite stale ACTIVE status and remaining credits', () => {
    expect(isSubscriptionCurrentlyEntitled(subscription, new Date(end.getTime() + 1))).toBe(false);
  });

  it('allows cancel-at-period-end semantics before the end (status remains ACTIVE)', () => {
    expect(isSubscriptionCurrentlyEntitled(subscription, new Date(end.getTime() - 1))).toBe(true);
  });

  it('allows a renewed cash row with a future period', () => {
    expect(
      isSubscriptionCurrentlyEntitled(
        { ...subscription, currentPeriodEnd: new Date('2026-09-19T12:00:00.000Z') },
        end,
      ),
    ).toBe(true);
  });

  it('uses the fixed-duration entitlement end instead of the Stripe billing period', () => {
    const fixed = {
      status: SubscriptionStatus.CANCELED,
      currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
      entitlementEndsAt: end,
    };
    expect(isSubscriptionCurrentlyEntitled(fixed, new Date(end.getTime() - 1))).toBe(true);
    expect(isSubscriptionCurrentlyEntitled(fixed, end)).toBe(false);
  });

  it('builds a strict greater-than database predicate for both effective end types', () => {
    expect(currentlyEntitledSubscriptionWhere(end)).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({ currentPeriodEnd: { gt: end } }),
          expect.objectContaining({ entitlementEndsAt: { gt: end } }),
        ]),
      }),
    );
  });
});
