-- AlterTable
ALTER TABLE "attendances" ADD COLUMN "checked_in_by_user_id" TEXT;

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_checked_in_by_user_id_fkey" FOREIGN KEY ("checked_in_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
