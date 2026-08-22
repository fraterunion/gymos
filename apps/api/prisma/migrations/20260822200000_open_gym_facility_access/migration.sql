-- Open Gym facility access.
--
-- Two independent concerns, both previously unrepresentable:
--   1. A physical visit that is NOT class participation (attendances.type = OPEN_GYM).
--   2. Whether a membership plan grants independent gym access, and during which local hours.
--
-- Door policy is deliberately plan-level rather than derived from ClassTemplate.isOpenGymSlot:
-- ARES plans have different Open Gym hours (Basic/Full 11:00-22:00, Open Gym plan 11:00-17:00)
-- while a class template is one shared object that cannot express per-plan policy.

-- 1. Visit discriminator ------------------------------------------------------------------

CREATE TYPE "CheckInType" AS ENUM ('CLASS', 'OPEN_GYM');

-- Every existing row is a class attendance by definition: scheduled_class_id was NOT NULL
-- until this migration, so the DEFAULT backfills all history correctly with no data statement.
ALTER TABLE "attendances" ADD COLUMN "type" "CheckInType" NOT NULL DEFAULT 'CLASS';

ALTER TABLE "attendances" ALTER COLUMN "scheduled_class_id" DROP NOT NULL;

-- The invariant that keeps class semantics intact at the storage layer: no code path can
-- create a CLASS row without a class, or attach an OPEN_GYM row to one. Every class-scoped
-- consumer INNER JOINs scheduled_classes, so OPEN_GYM rows are excluded from rosters,
-- capacity, show rate and credit counting purely as a consequence of this NULL.
ALTER TABLE "attendances"
  ADD CONSTRAINT "attendances_type_class_link_consistency"
  CHECK (
    ("type" = 'CLASS' AND "scheduled_class_id" IS NOT NULL)
    OR ("type" = 'OPEN_GYM' AND "scheduled_class_id" IS NULL)
  );

-- Serves the Open Gym double-scan lookup (studio + type + recent window) and the gym-traffic
-- / Open Gym usage reporting this record exists to enable.
CREATE INDEX "attendances_studio_id_type_checked_in_at_idx"
  ON "attendances"("studio_id", "type", "checked_in_at");

-- Note: attendances_scheduled_class_id_user_id_key is intentionally left as-is. Postgres
-- treats NULLs as distinct, so it still enforces one CLASS attendance per member per class
-- while placing no constraint on OPEN_GYM rows -- repeat visits in one day are legitimate
-- data. Accidental double scans are de-duplicated by a short time window in the service.

-- 2. Plan-level Open Gym entitlement -------------------------------------------------------

-- Deny by default: a plan grants Open Gym only when explicitly enabled. Never inferred from
-- marketing copy in membership_plans.description.
ALTER TABLE "membership_plans" ADD COLUMN "open_gym_access" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "membership_plans" ADD COLUMN "open_gym_window_start" TEXT;
ALTER TABLE "membership_plans" ADD COLUMN "open_gym_window_end" TEXT;

-- Both bounds are set together or neither is; a half-open window has no defined meaning.
ALTER TABLE "membership_plans"
  ADD CONSTRAINT "membership_plans_open_gym_window_paired"
  CHECK (
    ("open_gym_window_start" IS NULL AND "open_gym_window_end" IS NULL)
    OR ("open_gym_window_start" IS NOT NULL AND "open_gym_window_end" IS NOT NULL)
  );

-- 3. ARES plan configuration ---------------------------------------------------------------
--
-- Deterministic and idempotent. Scoped by studio slug AND plan name rather than by primary
-- key: the slug is a stable, human-verifiable business identifier, whereas a hardcoded cuid
-- cannot be reviewed by reading this file. Any database without an 'ares-fitness' studio
-- carrying these exact plan names -- dev, CI, every other tenant -- is left untouched.
--
-- Basic Access is a correction, not a new grant: its customer-facing description has always
-- promised "Open Gym (11am-10pm)" while its structured entitlement granted none, so members
-- paying for it would have been refused at the door.
--
-- Pro and Booty Lab are deliberately absent. They keep the false default, which matches both
-- their entitlement data and their plan copy. No other plan is touched by this statement.
UPDATE "membership_plans" mp
SET "open_gym_access"       = TRUE,
    "open_gym_window_start" = v.window_start,
    "open_gym_window_end"   = v.window_end
FROM (VALUES
  ('Basic Access', '11:00', '22:00'),
  ('Full Access',  '11:00', '22:00'),
  ('Open Gym',     '11:00', '17:00')
) AS v(plan_name, window_start, window_end)
WHERE mp."name" = v.plan_name
  AND mp."deleted_at" IS NULL
  AND mp."studio_id" IN (
    SELECT s."id" FROM "studios" s WHERE s."slug" = 'ares-fitness' AND s."deleted_at" IS NULL
  );
