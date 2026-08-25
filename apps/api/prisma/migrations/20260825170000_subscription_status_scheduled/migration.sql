-- Additive: future CASH successor for Stripe → Cash period-end handoff.
-- Not included in subscriptions_one_active_per_user_per_studio_idx (ACTIVE only).
-- Must be its own migration: new enum values cannot be used in the same transaction.

ALTER TYPE "SubscriptionStatus" ADD VALUE 'SCHEDULED';
