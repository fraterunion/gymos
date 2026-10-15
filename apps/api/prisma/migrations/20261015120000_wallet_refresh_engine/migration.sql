-- Smart Wallet 2.0 Stage 3: automatic pass refresh engine + pass lifecycle history. ADDITIVE ONLY.
--
-- 1. wallet_pass_refresh_jobs: durable refresh requests (one PENDING row per studio member,
--    enforced by a partial unique index Prisma cannot express).
-- 2. wallet_refresh_cursors: change-detection checkpoint.
-- 3. wallet_pass_events: append-only registration / download / APNs history (device stored as
--    a hash prefix only; no tokens). Retention handled by the refresh worker (180 days).
-- 4. wallet_pass_artifacts gains pushed_pass_version / last_pushed_at, plus an index for the
--    time-transition sweep. Existing DYNAMIC rows are backfilled as "already pushed" at their
--    current version, so deploying this never triggers a burst of pushes for content devices
--    already have. STATIC rows are untouched (the new column default applies).
--
-- No existing table's data changes except that one backfill of a column created here.
-- Lock impact: new tables are empty; ADD COLUMN with a constant default is metadata-only; the
-- backfill touches only DYNAMIC artifact rows (a handful); CREATE INDEX on wallet_pass_artifacts
-- (~130 rows, the production count read during Stage 1A) is instantaneous.
-- Rollback (recommended): code only. The previous API build never reads these objects, so they
-- stay in place. Removing them is a separate, deliberate step, verified on a scratch database:
--   DROP TABLE wallet_pass_events, wallet_refresh_cursors, wallet_pass_refresh_jobs;
--   DROP INDEX wallet_pass_artifacts_pass_mode_next_transition_at_idx;
--   ALTER TABLE wallet_pass_artifacts DROP COLUMN pushed_pass_version, DROP COLUMN last_pushed_at;
--   DROP TYPE "WalletPassEventType", "WalletPassRefreshStatus";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261015120000_wallet_refresh_engine';
-- The last statement is not optional: without it `prisma migrate status` still reports "up to
-- date" and a later deploy of this code would run against missing tables.

-- CreateEnum
CREATE TYPE "WalletPassRefreshStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "WalletPassEventType" AS ENUM ('REGISTERED', 'UNREGISTERED', 'PASS_RETRIEVED', 'PASS_NOT_MODIFIED', 'APNS_ACCEPTED', 'APNS_INVALID_TOKEN', 'APNS_FAILED');

-- AlterTable
ALTER TABLE "wallet_pass_artifacts" ADD COLUMN     "last_pushed_at" TIMESTAMP(3),
ADD COLUMN     "pushed_pass_version" INTEGER NOT NULL DEFAULT 0;

-- Existing dynamic passes: their current content is what devices already hold (it was pushed or
-- downloaded during staging tests), so it is not "unpushed".
UPDATE "wallet_pass_artifacts" SET "pushed_pass_version" = "pass_version" WHERE "pass_mode" = 'DYNAMIC';

-- CreateTable
CREATE TABLE "wallet_pass_refresh_jobs" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "WalletPassRefreshStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "trigger_count" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 6,
    "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "outcome" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_pass_refresh_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_refresh_cursors" (
    "source" TEXT NOT NULL,
    "position" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_refresh_cursors_pkey" PRIMARY KEY ("source")
);

-- CreateTable
CREATE TABLE "wallet_pass_events" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "wallet_pass_artifact_id" TEXT NOT NULL,
    "wallet_credential_id" TEXT NOT NULL,
    "type" "WalletPassEventType" NOT NULL,
    "device_hash" TEXT,
    "pass_version" INTEGER,
    "http_status" INTEGER,
    "detail" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_pass_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_pass_refresh_jobs_status_run_after_idx" ON "wallet_pass_refresh_jobs"("status", "run_after");

-- CreateIndex
CREATE INDEX "wallet_pass_refresh_jobs_status_lease_expires_at_idx" ON "wallet_pass_refresh_jobs"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "wallet_pass_refresh_jobs_studio_id_user_id_idx" ON "wallet_pass_refresh_jobs"("studio_id", "user_id");

-- CreateIndex
CREATE INDEX "wallet_pass_refresh_jobs_status_completed_at_idx" ON "wallet_pass_refresh_jobs"("status", "completed_at");

-- At most one PENDING refresh per studio member: concurrent triggers coalesce into it (the
-- enqueue statement upserts against this index). RUNNING/finished rows are unconstrained, so a
-- change that lands while a refresh runs still gets its own PENDING follow-up.
CREATE UNIQUE INDEX "wallet_pass_refresh_jobs_one_pending_per_member"
  ON "wallet_pass_refresh_jobs" ("studio_id", "user_id")
  WHERE "status" = 'PENDING';

-- CreateIndex
CREATE INDEX "wallet_pass_events_wallet_pass_artifact_id_occurred_at_idx" ON "wallet_pass_events"("wallet_pass_artifact_id", "occurred_at");

-- CreateIndex
CREATE INDEX "wallet_pass_events_studio_id_occurred_at_idx" ON "wallet_pass_events"("studio_id", "occurred_at");

-- CreateIndex
CREATE INDEX "wallet_pass_events_occurred_at_idx" ON "wallet_pass_events"("occurred_at");

-- CreateIndex
CREATE INDEX "wallet_pass_artifacts_pass_mode_next_transition_at_idx" ON "wallet_pass_artifacts"("pass_mode", "next_transition_at");

-- AddForeignKey
ALTER TABLE "wallet_pass_refresh_jobs" ADD CONSTRAINT "wallet_pass_refresh_jobs_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_pass_refresh_jobs" ADD CONSTRAINT "wallet_pass_refresh_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_pass_events" ADD CONSTRAINT "wallet_pass_events_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_pass_events" ADD CONSTRAINT "wallet_pass_events_wallet_pass_artifact_id_fkey" FOREIGN KEY ("wallet_pass_artifact_id") REFERENCES "wallet_pass_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
