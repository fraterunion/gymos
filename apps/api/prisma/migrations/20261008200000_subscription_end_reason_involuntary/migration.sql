-- Cancellation-reason accuracy. ADDITIVE ONLY: four new SubscriptionEndReason values so a
-- subscription Stripe ended for non-payment / a dispute / an unpaid first invoice, or that staff
-- canceled from the Admin, is no longer recorded as MEMBER_CANCELLED (which read as voluntary churn).
--
-- Kept in its own migration: Postgres forbids USING a value added by ALTER TYPE ... ADD VALUE inside
-- the same transaction, and `prisma migrate deploy` wraps each migration in one transaction.
-- No existing row is touched; historical rows are corrected only by a separately approved backfill.
-- Rollback note: the previous API build cannot READ a row holding one of these values (Prisma
-- validates enum values on read), so a code rollback must be paired with mapping any such rows
-- back to MEMBER_CANCELLED (see docs/BILLING_RELIABILITY_RECONCILIATION.md, rollback plan).

ALTER TYPE "SubscriptionEndReason" ADD VALUE 'PAYMENT_FAILED';
ALTER TYPE "SubscriptionEndReason" ADD VALUE 'PAYMENT_DISPUTED';
ALTER TYPE "SubscriptionEndReason" ADD VALUE 'INCOMPLETE_EXPIRED';
ALTER TYPE "SubscriptionEndReason" ADD VALUE 'STAFF_CANCELLED';
