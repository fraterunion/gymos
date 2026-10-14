-- Smart Wallet 2.0 Stage 1A: dynamic Apple pass foundation. ADDITIVE ONLY.
--
-- 1. wallet_pass_artifacts gains nullable/defaulted columns describing an optional DYNAMIC mode.
--    Every existing row becomes pass_mode = 'STATIC' through the column DEFAULT (no data
--    statement, no table rewrite on PostgreSQL 11+); no existing value is changed, so the
--    stored .pkpass bytes, serial numbers and barcodes of every existing pass are untouched.
-- 2. wallet_pass_registrations is a new, empty table for PassKit device registrations.
--
-- Lock impact: ADD COLUMN with constant defaults is metadata-only; the CHECK constraint
-- validates the existing rows (~130) under a brief ACCESS EXCLUSIVE lock — milliseconds.
-- CREATE TABLE/INDEX touch only the new table; each FOREIGN KEY briefly locks the referenced
-- table (studios, wallet_pass_artifacts) while validating an EMPTY referencing table.
-- Rollback: the previous API build never reads these objects. They can stay in place, or be
-- removed with: DROP TABLE wallet_pass_registrations; ALTER TABLE wallet_pass_artifacts DROP
-- CONSTRAINT wallet_pass_artifacts_dynamic_fields_consistency, DROP COLUMN ... (the nine
-- columns below); DROP TYPE "WalletPassMode".

-- CreateEnum
CREATE TYPE "WalletPassMode" AS ENUM ('STATIC', 'DYNAMIC');

-- AlterTable
ALTER TABLE "wallet_pass_artifacts" ADD COLUMN     "authentication_token_hash" TEXT,
ADD COLUMN     "content_hash" TEXT,
ADD COLUMN     "dynamic_enabled_at" TIMESTAMP(3),
ADD COLUMN     "dynamic_template_version" INTEGER,
ADD COLUMN     "last_modified_at" TIMESTAMP(3),
ADD COLUMN     "next_transition_at" TIMESTAMP(3),
ADD COLUMN     "pass_mode" "WalletPassMode" NOT NULL DEFAULT 'STATIC',
ADD COLUMN     "pass_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "snapshot_schema_version" INTEGER;

-- A DYNAMIC row is only meaningful as a complete Apple pass with a token and a content
-- version: the database refuses anything less, so no code path can leave a half-enrolled pass
-- that the PassKit service would have to guess about. STATIC rows are unconstrained (as before).
ALTER TABLE "wallet_pass_artifacts"
  ADD CONSTRAINT "wallet_pass_artifacts_dynamic_fields_consistency"
  CHECK (
    "pass_mode" = 'STATIC'
    OR (
      "platform" = 'APPLE'
      AND "pkpass_data" IS NOT NULL
      AND "authentication_token_hash" IS NOT NULL
      AND "dynamic_template_version" IS NOT NULL
      AND "content_hash" IS NOT NULL
      AND "last_modified_at" IS NOT NULL
      AND "dynamic_enabled_at" IS NOT NULL
    )
  );

-- CreateTable
CREATE TABLE "wallet_pass_registrations" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "wallet_pass_artifact_id" TEXT NOT NULL,
    "device_library_identifier" TEXT NOT NULL,
    "pass_type_identifier" TEXT NOT NULL,
    "serial_number" TEXT NOT NULL,
    "push_token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_pass_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_pass_registrations_wallet_pass_artifact_id_idx" ON "wallet_pass_registrations"("wallet_pass_artifact_id");

-- CreateIndex
CREATE INDEX "wallet_pass_registrations_studio_id_idx" ON "wallet_pass_registrations"("studio_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_pass_registrations_device_library_identifier_pass_ty_key" ON "wallet_pass_registrations"("device_library_identifier", "pass_type_identifier", "serial_number");

-- AddForeignKey
ALTER TABLE "wallet_pass_registrations" ADD CONSTRAINT "wallet_pass_registrations_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_pass_registrations" ADD CONSTRAINT "wallet_pass_registrations_wallet_pass_artifact_id_fkey" FOREIGN KEY ("wallet_pass_artifact_id") REFERENCES "wallet_pass_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
