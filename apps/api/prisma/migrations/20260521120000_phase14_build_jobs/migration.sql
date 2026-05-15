-- Phase 14 — tracked white-label build requests (no EAS execution yet).

CREATE TYPE "BuildJobPlatform" AS ENUM ('IOS', 'ANDROID');
CREATE TYPE "BuildJobProfile" AS ENUM ('PREVIEW', 'PRODUCTION');
CREATE TYPE "BuildJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

CREATE TABLE "build_jobs" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "platform" "BuildJobPlatform" NOT NULL,
    "profile" "BuildJobProfile" NOT NULL,
    "status" "BuildJobStatus" NOT NULL DEFAULT 'QUEUED',
    "app_display_name" TEXT NOT NULL,
    "app_scheme" TEXT NOT NULL,
    "expo_slug" TEXT NOT NULL,
    "ios_bundle_identifier" TEXT NOT NULL,
    "android_package" TEXT NOT NULL,
    "eas_build_url" TEXT,
    "artifact_url" TEXT,
    "error_message" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "build_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "build_jobs_studio_id_idx" ON "build_jobs"("studio_id");
CREATE INDEX "build_jobs_status_idx" ON "build_jobs"("status");
CREATE INDEX "build_jobs_requested_at_idx" ON "build_jobs"("requested_at");

ALTER TABLE "build_jobs" ADD CONSTRAINT "build_jobs_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "build_jobs" ADD CONSTRAINT "build_jobs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
