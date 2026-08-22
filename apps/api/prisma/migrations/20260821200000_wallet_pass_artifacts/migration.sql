-- Member Experience 1.1 Phase 2 — durable pass-provisioning records.
-- Solves "member re-taps Add to Wallet" without ever needing the raw credential again
-- (Phase 1 deliberately never persists it): APPLE rows carry the already-signed .pkpass
-- bytes; GOOGLE rows carry only a pointer to the object Google already stores durably.
--
-- Hand-authored, same reason as 20260821180000_wallet_credential_foundation: this repo's
-- `prisma migrate dev` shadow-database replay currently fails against an earlier historical
-- migration (P3006), so this file matches this repo's established migration.sql style and
-- is applied via `prisma migrate deploy` (no shadow database required).

-- CreateEnum
CREATE TYPE "WalletPassPlatform" AS ENUM ('APPLE', 'GOOGLE');

-- CreateTable
CREATE TABLE "wallet_pass_artifacts" (
    "id"                    TEXT                 NOT NULL,
    "wallet_credential_id"  TEXT                 NOT NULL,
    "platform"              "WalletPassPlatform" NOT NULL,
    "pkpass_data"           BYTEA,
    "google_object_id"      TEXT,
    "created_at"            TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_pass_artifacts_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "wallet_pass_artifacts" ADD CONSTRAINT "wallet_pass_artifacts_wallet_credential_id_fkey"
    FOREIGN KEY ("wallet_credential_id") REFERENCES "wallet_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex (one artifact per platform per credential)
CREATE UNIQUE INDEX "wallet_pass_artifacts_wallet_credential_id_platform_key"
    ON "wallet_pass_artifacts"("wallet_credential_id", "platform");
