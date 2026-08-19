import { Prisma, SubscriptionStatus } from '@prisma/client';

export const MEMBERSHIP_EXPIRED_MESSAGE = 'MEMBERSHIP_EXPIRED';

/**
 * Canonical synchronous entitlement predicate.
 * Fixed-duration products use entitlementEndsAt; every other subscription uses
 * currentPeriodEnd. The end is exclusive: entitlement is invalid at the exact
 * instant the effective end is reached, regardless of a stale ACTIVE status.
 */
export function currentlyEntitledSubscriptionWhere(now: Date): Prisma.SubscriptionWhereInput {
  return {
    OR: [
      {
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
        entitlementEndsAt: null,
        currentPeriodEnd: { gt: now },
      },
      {
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.TRIALING,
            SubscriptionStatus.CANCELED,
          ],
        },
        entitlementEndsAt: { gt: now },
      },
    ],
  };
}
export function isSubscriptionCurrentlyEntitled(
  subscription: {
    status: SubscriptionStatus;
    currentPeriodEnd: Date | null;
    entitlementEndsAt: Date | null;
  },
  now: Date,
): boolean {
  const allowedStatus =
    subscription.status === SubscriptionStatus.ACTIVE ||
    subscription.status === SubscriptionStatus.TRIALING ||
    (subscription.status === SubscriptionStatus.CANCELED && subscription.entitlementEndsAt !== null);
  const effectiveEnd = subscription.entitlementEndsAt ?? subscription.currentPeriodEnd;
  return allowedStatus && effectiveEnd !== null && now < effectiveEnd;
}
