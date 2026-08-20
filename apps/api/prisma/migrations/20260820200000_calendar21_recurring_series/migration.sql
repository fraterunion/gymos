-- Calendar & Classes 2.1 — recurring series foundation

CREATE TYPE "ScheduleOccurrenceExceptionKind" AS ENUM ('DETACHED');

ALTER TABLE "schedule_templates"
  ADD COLUMN "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "ends_at" TIMESTAMP(3),
  ADD COLUMN "interval_weeks" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "scheduled_classes"
  ADD COLUMN "schedule_template_id" TEXT,
  ADD COLUMN "exception_kind" "ScheduleOccurrenceExceptionKind";

ALTER TABLE "scheduled_classes"
  ADD CONSTRAINT "scheduled_classes_schedule_template_id_fkey"
  FOREIGN KEY ("schedule_template_id") REFERENCES "schedule_templates"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "scheduled_classes_schedule_template_id_idx"
  ON "scheduled_classes"("schedule_template_id");

CREATE INDEX "scheduled_classes_studio_id_schedule_template_id_starts_at_idx"
  ON "scheduled_classes"("studio_id", "schedule_template_id", "starts_at");
