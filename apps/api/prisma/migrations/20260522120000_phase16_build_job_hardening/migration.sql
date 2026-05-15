-- Phase 16 — build pipeline hardening (tracking + error categories)
CREATE TYPE "BuildJobErrorCategory" AS ENUM (
  'CONFIG_ERROR',
  'AUTH_ERROR',
  'EAS_OUTAGE',
  'BUILD_FAILED',
  'TIMEOUT',
  'UNKNOWN'
);

ALTER TABLE "build_jobs" ADD COLUMN "submitted_at" TIMESTAMP(3);
ALTER TABLE "build_jobs" ADD COLUMN "expo_build_id" TEXT;
ALTER TABLE "build_jobs" ADD COLUMN "expo_build_status" TEXT;
ALTER TABLE "build_jobs" ADD COLUMN "last_checked_at" TIMESTAMP(3);
ALTER TABLE "build_jobs" ADD COLUMN "error_category" "BuildJobErrorCategory";

CREATE INDEX "build_jobs_started_at_idx" ON "build_jobs"("started_at");
