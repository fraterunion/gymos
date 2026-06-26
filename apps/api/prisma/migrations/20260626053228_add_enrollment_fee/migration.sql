-- CreateEnum
CREATE TYPE "EnrollmentFeeStatus" AS ENUM ('PAID', 'WAIVED');

-- CreateEnum
CREATE TYPE "WaivedReason" AS ENUM ('FIRST_N_PROMO', 'FIRST_N_PROMO_OVERFLOW', 'ADMIN_WAIVER', 'STAFF', 'LEGACY_MEMBER', 'OTHER');

-- CreateEnum
CREATE TYPE "CampaignType" AS ENUM ('FIRST_N_MEMBERS');

-- CreateEnum
CREATE TYPE "CampaignAppliesTo" AS ENUM ('ENROLLMENT_FEE');

-- CreateTable
CREATE TABLE "studio_enrollment_settings" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "enrollment_fee_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'mxn',
    "campaign_enabled" BOOLEAN NOT NULL DEFAULT false,
    "campaign_type" "CampaignType",
    "campaign_name" TEXT,
    "campaign_limit" INTEGER,
    "campaign_discount_pct" INTEGER,
    "campaign_applies_to" "CampaignAppliesTo",
    "stripe_product_id" TEXT,
    "stripe_price_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "studio_enrollment_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_enrollments" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "settings_id" TEXT NOT NULL,
    "status" "EnrollmentFeeStatus" NOT NULL,
    "member_number" INTEGER,
    "founder_number" INTEGER,
    "waived_reason" "WaivedReason",
    "stripe_checkout_session_id" TEXT,
    "finalized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "studio_enrollment_settings_studio_id_key" ON "studio_enrollment_settings"("studio_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_enrollments_stripe_checkout_session_id_key" ON "member_enrollments"("stripe_checkout_session_id");

-- CreateIndex
CREATE INDEX "member_enrollments_studio_id_idx" ON "member_enrollments"("studio_id");

-- CreateIndex
CREATE INDEX "member_enrollments_user_id_idx" ON "member_enrollments"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_enrollments_studio_id_user_id_key" ON "member_enrollments"("studio_id", "user_id");

-- AddForeignKey
ALTER TABLE "studio_enrollment_settings" ADD CONSTRAINT "studio_enrollment_settings_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_enrollments" ADD CONSTRAINT "member_enrollments_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_enrollments" ADD CONSTRAINT "member_enrollments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_enrollments" ADD CONSTRAINT "member_enrollments_settings_id_fkey" FOREIGN KEY ("settings_id") REFERENCES "studio_enrollment_settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
