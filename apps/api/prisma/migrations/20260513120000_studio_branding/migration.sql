-- AlterTable
ALTER TABLE "studios"
  ADD COLUMN "app_name" TEXT,
  ADD COLUMN "brand_primary_color" TEXT,
  ADD COLUMN "brand_secondary_color" TEXT,
  ADD COLUMN "brand_logo_url" TEXT,
  ADD COLUMN "brand_icon_url" TEXT,
  ADD COLUMN "brand_splash_url" TEXT,
  ADD COLUMN "support_email" TEXT,
  ADD COLUMN "support_phone" TEXT,
  ADD COLUMN "privacy_url" TEXT,
  ADD COLUMN "terms_url" TEXT,
  ADD COLUMN "ios_bundle_id" TEXT,
  ADD COLUMN "android_package_name" TEXT,
  ADD COLUMN "app_store_url" TEXT,
  ADD COLUMN "play_store_url" TEXT;
