-- Phase 27: Explicit membership plan class template access
--
-- Adds all_classes_access (explicit unrestricted flag) and a join table for
-- per-template entitlements. Preserves Phase 26 allowed_categories for legacy
-- category-based plans (e.g. Hyrox-only).
--
-- Backfill:
--   • all_classes_access = true when allowed_categories is empty (all existing
--     all-access plans — Full Access, Basic, Elite, etc.)
--   • all_classes_access = false when allowed_categories is non-empty (Hyrox)

CREATE TABLE "membership_plan_class_access" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "membership_plan_id" TEXT NOT NULL,
    "class_template_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_plan_class_access_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "membership_plans"
  ADD COLUMN "all_classes_access" BOOLEAN NOT NULL DEFAULT true;

-- Restricted legacy category plans (non-empty allowed_categories).
UPDATE "membership_plans"
SET "all_classes_access" = false
WHERE cardinality("allowed_categories") > 0;

CREATE UNIQUE INDEX "membership_plan_class_access_membership_plan_id_class_template_id_key"
  ON "membership_plan_class_access"("membership_plan_id", "class_template_id");

CREATE INDEX "membership_plan_class_access_studio_id_idx"
  ON "membership_plan_class_access"("studio_id");

CREATE INDEX "membership_plan_class_access_membership_plan_id_idx"
  ON "membership_plan_class_access"("membership_plan_id");

CREATE INDEX "membership_plan_class_access_class_template_id_idx"
  ON "membership_plan_class_access"("class_template_id");

ALTER TABLE "membership_plan_class_access"
  ADD CONSTRAINT "membership_plan_class_access_studio_id_fkey"
  FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "membership_plan_class_access"
  ADD CONSTRAINT "membership_plan_class_access_membership_plan_id_fkey"
  FOREIGN KEY ("membership_plan_id") REFERENCES "membership_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "membership_plan_class_access"
  ADD CONSTRAINT "membership_plan_class_access_class_template_id_fkey"
  FOREIGN KEY ("class_template_id") REFERENCES "class_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
