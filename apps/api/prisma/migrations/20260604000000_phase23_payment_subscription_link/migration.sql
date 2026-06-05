-- Phase 23: Link Payment rows to Subscription and MembershipPlan, add paidAt timestamp

ALTER TABLE "payments"
    ADD COLUMN "subscription_id"    TEXT,
    ADD COLUMN "membership_plan_id" TEXT,
    ADD COLUMN "paid_at"            TIMESTAMPTZ;

-- FK: payments → subscriptions (nullable, set null on delete)
ALTER TABLE "payments"
    ADD CONSTRAINT "payments_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL;

-- FK: payments → membership_plans (nullable, set null on delete)
ALTER TABLE "payments"
    ADD CONSTRAINT "payments_membership_plan_id_fkey"
    FOREIGN KEY ("membership_plan_id") REFERENCES "membership_plans"("id") ON DELETE SET NULL;

-- Index for subscription-level payment history queries
CREATE INDEX "payments_subscription_id_idx" ON "payments"("subscription_id");
