-- AlterEnum: append STAFF (PostgreSQL adds new enum values at the end of the type)
ALTER TYPE "Role" ADD VALUE 'STAFF';

-- AlterTable
ALTER TABLE "membership_plans" ADD COLUMN "class_credits" INTEGER;
