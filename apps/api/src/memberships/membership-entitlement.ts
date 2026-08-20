import { Prisma, SubscriptionStatus } from '@prisma/client';

export const MEMBERSHIP_EXPIRED_MESSAGE = 'MEMBERSHIP_EXPIRED';

export type MembershipAccessState = 'ENTITLED' | 'NOT_STARTED' | 'EXPIRED' | 'INACTIVE';
export type MembershipLifecycleStatus =
  | 'ACTIVE'
  | 'TRIALING'
  | 'ENDING'
  | 'PAST_DUE'
  | 'PAUSED'
  | 'CANCELED'
  | 'REPLACED'
  | 'SCHEDULED'
  | 'EXPIRED';

export type MembershipLifecycleSnapshot = {
  accessState: MembershipAccessState;
  lifecycleStatus: MembershipLifecycleStatus;
  isEntitled: boolean;
  effectiveStart: Date | null;
  effectiveEnd: Date | null;
};

type SubscriptionEntitlementFields = {
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  entitlementEndsAt: Date | null;
  cancelAtPeriodEnd?: boolean;
};

function hasAllowedAccessStatus(subscription: SubscriptionEntitlementFields): boolean {
  return (
    subscription.status === SubscriptionStatus.ACTIVE ||
    subscription.status === SubscriptionStatus.TRIALING ||
    (subscription.status === SubscriptionStatus.CANCELED && subscription.entitlementEndsAt !== null)
  );
}

/**
 * Derives operational lifecycle/access state without rewriting provider/payment state.
 * Access windows are [effectiveStart, effectiveEnd); the end boundary is exclusive.
 */
export function deriveMembershipLifecycle(
  subscription: SubscriptionEntitlementFields,
  now: Date,
): MembershipLifecycleSnapshot {
  const effectiveStart = subscription.currentPeriodStart;
  const effectiveEnd = subscription.entitlementEndsAt ?? subscription.currentPeriodEnd;
  const allowedStatus = hasAllowedAccessStatus(subscription);

  if (allowedStatus && effectiveStart !== null && now < effectiveStart) {
    return {
      accessState: 'NOT_STARTED',
      lifecycleStatus: 'SCHEDULED',
      isEntitled: false,
      effectiveStart,
      effectiveEnd,
    };
  }

  if (allowedStatus && effectiveEnd !== null && now >= effectiveEnd) {
    return {
      accessState: 'EXPIRED',
      lifecycleStatus: 'EXPIRED',
      isEntitled: false,
      effectiveStart,
      effectiveEnd,
    };
  }

  if (allowedStatus && effectiveEnd !== null) {
    const ending = subscription.cancelAtPeriodEnd || subscription.status === SubscriptionStatus.CANCELED;
    return {
      accessState: 'ENTITLED',
      lifecycleStatus: ending
        ? 'ENDING'
        : subscription.status === SubscriptionStatus.TRIALING
          ? 'TRIALING'
          : 'ACTIVE',
      isEntitled: true,
      effectiveStart,
      effectiveEnd,
    };
  }

  return {
    accessState: 'INACTIVE',
    lifecycleStatus: subscription.status,
    isEntitled: false,
    effectiveStart,
    effectiveEnd,
  };
}

/** Canonical DB predicate equivalent to deriveMembershipLifecycle(...).isEntitled. */
export function currentlyEntitledSubscriptionWhere(now: Date): Prisma.SubscriptionWhereInput {
  return {
    AND: [
      { OR: [{ currentPeriodStart: null }, { currentPeriodStart: { lte: now } }] },
      {
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
      },
    ],
  };
}

export function isSubscriptionCurrentlyEntitled(
  subscription: SubscriptionEntitlementFields,
  now: Date,
): boolean {
  return deriveMembershipLifecycle(subscription, now).isEntitled;
}
