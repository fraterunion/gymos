-- CreateEnum
CREATE TYPE "SubscriptionEndReason" AS ENUM (
  'MEMBER_CANCELLED',
  'SUPERSEDED_PAYMENT_METHOD',
  'SUPERSEDED_RENEWAL',
  'SUPERSEDED_PLAN_CHANGE'
);

-- AlterTable
ALTER TABLE "subscriptions"
  ADD COLUMN "superseded_by_subscription_id" TEXT,
  ADD COLUMN "end_reason" "SubscriptionEndReason";

-- AddForeignKey
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_superseded_by_subscription_id_fkey"
  FOREIGN KEY ("superseded_by_subscription_id")
  REFERENCES "subscriptions"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
