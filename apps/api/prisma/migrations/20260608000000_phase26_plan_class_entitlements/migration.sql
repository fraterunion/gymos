-- Phase 26: Membership plan class entitlements
--
-- 1. Adds HYROX to the ClassCategory enum so Hyrox training sessions can be
--    distinguished from generic HIIT classes (both existed as HIIT before).
--
-- 2. Adds allowed_categories to membership_plans.
--    Empty array  →  all-access (preserves existing plan behaviour — every
--                     existing row defaults to '{}', no disruption to active
--                     subscriptions).
--    Non-empty    →  member may only book classes whose class_template.category
--                     is in this list. Day Pass access is never restricted by
--                     this column (enforced in BookingsService).

-- Step 1: extend the enum.
-- ALTER TYPE ... ADD VALUE is safe in Postgres ≥ 12 inside a transaction.
-- The value is appended before 'OTHER' to keep the semantic ordering intact.
ALTER TYPE "ClassCategory" ADD VALUE 'HYROX' BEFORE 'OTHER';

-- Step 2: add the column.
-- NOT NULL DEFAULT '{}' means every existing plan row gets an empty array
-- (all-access) without a data migration.
ALTER TABLE "membership_plans"
  ADD COLUMN "allowed_categories" "ClassCategory"[] NOT NULL DEFAULT '{}';
