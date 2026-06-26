-- CreateEnum
CREATE TYPE "ScheduleGenerationTrigger" AS ENUM ('MANUAL', 'AUTOMATIC');

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_membership_plan_id_fkey";

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_subscription_id_fkey";

-- DropForeignKey
ALTER TABLE "studio_member_profiles" DROP CONSTRAINT "studio_member_profiles_studio_id_fkey";

-- DropForeignKey
ALTER TABLE "studio_member_profiles" DROP CONSTRAINT "studio_member_profiles_user_id_fkey";

-- AlterTable
ALTER TABLE "build_jobs" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "class_templates" ALTER COLUMN "equipment" DROP DEFAULT,
ALTER COLUMN "tags" DROP DEFAULT;

-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "paid_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "studio_member_profiles" ALTER COLUMN "birthdate" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "tags" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- CreateTable
CREATE TABLE "schedule_templates" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "class_template_id" TEXT NOT NULL,
    "instructor_id" TEXT,
    "day_of_week" INTEGER NOT NULL,
    "start_time" TEXT NOT NULL,
    "capacity" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "schedule_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_generation_runs" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "triggered_by" "ScheduleGenerationTrigger" NOT NULL,
    "user_id" TEXT,
    "is_dry_run" BOOLEAN NOT NULL DEFAULT false,
    "from_date" TIMESTAMP(3) NOT NULL,
    "to_date" TIMESTAMP(3) NOT NULL,
    "generated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,
    "breakdown" JSONB,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "schedule_generation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_automation_settings" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "min_future_days" INTEGER NOT NULL DEFAULT 90,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_automation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedule_templates_studio_id_idx" ON "schedule_templates"("studio_id");

-- CreateIndex
CREATE INDEX "schedule_templates_studio_id_active_idx" ON "schedule_templates"("studio_id", "active");

-- CreateIndex
CREATE INDEX "schedule_templates_studio_id_day_of_week_idx" ON "schedule_templates"("studio_id", "day_of_week");

-- CreateIndex
CREATE INDEX "schedule_generation_runs_studio_id_idx" ON "schedule_generation_runs"("studio_id");

-- CreateIndex
CREATE INDEX "schedule_generation_runs_studio_id_started_at_idx" ON "schedule_generation_runs"("studio_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_automation_settings_studio_id_key" ON "schedule_automation_settings"("studio_id");

-- CreateIndex
CREATE INDEX "class_templates_default_instructor_id_idx" ON "class_templates"("default_instructor_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_membership_plan_id_fkey" FOREIGN KEY ("membership_plan_id") REFERENCES "membership_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio_member_profiles" ADD CONSTRAINT "studio_member_profiles_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio_member_profiles" ADD CONSTRAINT "studio_member_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_class_template_id_fkey" FOREIGN KEY ("class_template_id") REFERENCES "class_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_instructor_id_fkey" FOREIGN KEY ("instructor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_generation_runs" ADD CONSTRAINT "schedule_generation_runs_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_generation_runs" ADD CONSTRAINT "schedule_generation_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_automation_settings" ADD CONSTRAINT "schedule_automation_settings_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
