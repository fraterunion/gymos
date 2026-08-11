import { SubscriptionStatus } from '@prisma/client';

/** Statuses that represent a membership still entitled to renew or remain current. */
export const RENEWABLE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.PAUSED,
];

export const STRIPE_TERMINAL_STATUSES = new Set<SubscriptionStatus>([
  SubscriptionStatus.CANCELED,
]);
