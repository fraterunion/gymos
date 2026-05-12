import { SubscriptionStatus } from '@prisma/client';

/**
 * Maps Stripe subscription lifecycle statuses to our Prisma enum.
 * Stripe is the source of truth; this is applied on webhook sync only.
 */
export function mapStripeSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
      return SubscriptionStatus.ACTIVE;
    case 'trialing':
      return SubscriptionStatus.TRIALING;
    case 'past_due':
      return SubscriptionStatus.PAST_DUE;
    case 'canceled':
      return SubscriptionStatus.CANCELED;
    case 'unpaid':
      return SubscriptionStatus.PAST_DUE;
    case 'incomplete':
      return SubscriptionStatus.PAUSED;
    case 'incomplete_expired':
      return SubscriptionStatus.CANCELED;
    case 'paused':
      return SubscriptionStatus.PAUSED;
    default:
      // Forward-compatible if Stripe adds new statuses before we migrate.
      return SubscriptionStatus.PAUSED;
  }
}
