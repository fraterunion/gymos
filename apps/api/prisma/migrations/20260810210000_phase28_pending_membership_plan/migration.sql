-- Phase 28: pending membership plan for scheduled Stripe downgrades.
-- membershipPlanId remains the CURRENT effective plan until Stripe phase transition.

ALTER TABLE "subscriptions"
  ADD COLUMN "pending_membership_plan_id" TEXT;

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_pending_membership_plan_id_fkey"
  FOREIGN KEY ("pending_membership_plan_id") REFERENCES "membership_plans"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "subscriptions_pending_membership_plan_id_idx"
  ON "subscriptions"("pending_membership_plan_id");
