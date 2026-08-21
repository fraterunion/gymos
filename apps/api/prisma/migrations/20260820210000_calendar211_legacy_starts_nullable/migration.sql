-- Calendar 2.1.1 — canonical legacy template start boundary
--
-- NULL starts_at  → pre-2.1 / implicit weekly rule (unbounded start)
-- NOT NULL        → Calendar 2.1 explicit recurring series boundary

ALTER TABLE "schedule_templates"
  ALTER COLUMN "starts_at" DROP NOT NULL,
  ALTER COLUMN "starts_at" DROP DEFAULT;

-- Rows that existed before Calendar 2.1 migration finished were backfilled with
-- CURRENT_TIMESTAMP (migration apply time), not author intent.
UPDATE "schedule_templates" st
SET "starts_at" = NULL
WHERE st."starts_at" IS NOT NULL
  AND st."created_at" < (
    SELECT pm."finished_at"
    FROM "_prisma_migrations" pm
    WHERE pm."migration_name" = '20260820200000_calendar21_recurring_series'
      AND pm."finished_at" IS NOT NULL
      AND pm."rolled_back_at" IS NULL
    LIMIT 1
  );

-- Templates created via the legacy schedule-template API after 2.1 deploy inherit
-- starts_at ≈ created_at (implicit unbounded weekly rule, not an explicit series).
UPDATE "schedule_templates" st
SET "starts_at" = NULL
WHERE st."starts_at" IS NOT NULL
  AND st."created_at" >= (
    SELECT pm."finished_at"
    FROM "_prisma_migrations" pm
    WHERE pm."migration_name" = '20260820200000_calendar21_recurring_series'
      AND pm."finished_at" IS NOT NULL
      AND pm."rolled_back_at" IS NULL
    LIMIT 1
  )
  AND ABS(EXTRACT(EPOCH FROM (st."starts_at" - st."created_at"))) < 60;
