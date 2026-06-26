-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('PLATFORM_ADMIN');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "platform_role" "PlatformRole";
