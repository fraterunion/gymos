-- MM-1 — Multi-membership additive foundation. STRICTLY ADDITIVE:
--   * no existing index is dropped (subscriptions_one_active_per_user_per_studio_idx and
--     subscriptions_one_scheduled_per_user_per_studio_idx remain in force — the final
--     constraint swap is a separate, gated migration)
--   * historical Booking/Attendance rows stay valid with NULL attribution
--   * exclusive_group_key is a PURCHASE-TIME SNAPSHOT: later edits to
--     membership_plans.exclusive_group must never rewrite existing subscription rows,
--     which is why the backfill below runs exactly once, here.

-- Compatibility metadata
ALTER TABLE "membership_plans" ADD COLUMN "exclusive_group" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "exclusive_group_key" TEXT;

-- Entitlement attribution (which membership paid for this consumption)
ALTER TABLE "bookings" ADD COLUMN "subscription_id" TEXT;
ALTER TABLE "attendances" ADD COLUMN "subscription_id" TEXT;

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "bookings_subscription_id_idx" ON "bookings"("subscription_id");
CREATE INDEX "attendances_subscription_id_idx" ON "attendances"("subscription_id");
CREATE INDEX "subscriptions_studio_id_user_id_exclusive_group_key_idx"
  ON "subscriptions"("studio_id", "user_id", "exclusive_group_key");

-- Backfill: every existing plan is CORE (mutually exclusive with every other CORE plan)
-- until a studio explicitly marks a plan stackable. This preserves today's
-- one-membership-per-member behavior bit-for-bit for all existing data.
UPDATE "membership_plans" SET "exclusive_group" = 'CORE' WHERE "exclusive_group" IS NULL;

-- Snapshot backfill for existing subscription rows from their plan's (just-set) group.
UPDATE "subscriptions" s
SET "exclusive_group_key" = mp."exclusive_group"
FROM "membership_plans" mp
WHERE mp."id" = s."membership_plan_id"
  AND s."exclusive_group_key" IS NULL;
