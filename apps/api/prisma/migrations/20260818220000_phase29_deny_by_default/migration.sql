-- Phase 29: deny-by-default class entitlement
--
-- Changes:
--   1. entitlementDays on membership_plans: separates billing interval from access duration
--   2. entitlementEndsAt on subscriptions: GymOS-controlled, never overwritten by Stripe
--   3. isOpenGymSlot + accessWindow on class_templates: Open Gym enforcement
--   4. day_pass_class_access table: explicit Day Pass allowlist (deny-by-default)

-- 1. entitlementDays — billing cycle and entitlement window can now differ
ALTER TABLE "membership_plans" ADD COLUMN "entitlement_days" INTEGER;

-- 2. entitlementEndsAt — access anchor for fixed-duration products (e.g., Booty Lab 45-day)
ALTER TABLE "subscriptions" ADD COLUMN "entitlement_ends_at" TIMESTAMPTZ;

-- 3. Open Gym slot metadata
ALTER TABLE "class_templates" ADD COLUMN "is_open_gym_slot" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "class_templates" ADD COLUMN "access_window_start" TEXT;
ALTER TABLE "class_templates" ADD COLUMN "access_window_end" TEXT;

-- 4. Day Pass explicit class template allowlist
CREATE TABLE "day_pass_class_access" (
  "id"                TEXT         NOT NULL,
  "studio_id"         TEXT         NOT NULL,
  "class_template_id" TEXT         NOT NULL,
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "day_pass_class_access_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "day_pass_class_access_studio_id_fkey"
    FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "day_pass_class_access_class_template_id_fkey"
    FOREIGN KEY ("class_template_id") REFERENCES "class_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "day_pass_class_access_studio_id_class_template_id_key"
  ON "day_pass_class_access"("studio_id", "class_template_id");
CREATE INDEX "day_pass_class_access_studio_id_idx"
  ON "day_pass_class_access"("studio_id");
CREATE INDEX "day_pass_class_access_class_template_id_idx"
  ON "day_pass_class_access"("class_template_id");
