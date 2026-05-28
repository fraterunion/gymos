-- Phase 20 — Studio staff profile (coach/front-desk/manager metadata)

-- StaffType enum
CREATE TYPE "StaffType" AS ENUM ('COACH', 'FRONT_DESK', 'MANAGER', 'OPERATIONS', 'OTHER');

-- StudioStaffProfile table
CREATE TABLE "studio_staff_profiles" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "staff_type" "StaffType" NOT NULL DEFAULT 'OTHER',
    "phone" TEXT,
    "bio" TEXT,
    "specialties" TEXT[],
    "photo_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "studio_staff_profiles_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "studio_staff_profiles" ADD CONSTRAINT "studio_staff_profiles_studio_id_fkey"
    FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "studio_staff_profiles" ADD CONSTRAINT "studio_staff_profiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unique + indexes
CREATE UNIQUE INDEX "studio_staff_profiles_studio_id_user_id_key" ON "studio_staff_profiles"("studio_id", "user_id");
CREATE INDEX "studio_staff_profiles_studio_id_idx" ON "studio_staff_profiles"("studio_id");
CREATE INDEX "studio_staff_profiles_studio_id_is_active_idx" ON "studio_staff_profiles"("studio_id", "is_active");
