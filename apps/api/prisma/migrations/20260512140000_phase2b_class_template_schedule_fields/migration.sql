-- AlterTable
ALTER TABLE "class_templates" ADD COLUMN "default_capacity" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "class_templates" ADD COLUMN "color" TEXT;
ALTER TABLE "class_templates" ADD COLUMN "default_instructor_id" TEXT;

-- AlterTable
ALTER TABLE "scheduled_classes" ADD COLUMN "cancel_reason" TEXT;

-- AddForeignKey
ALTER TABLE "class_templates" ADD CONSTRAINT "class_templates_default_instructor_id_fkey" FOREIGN KEY ("default_instructor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
