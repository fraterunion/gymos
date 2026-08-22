-- Member Experience 1.1 — Digital Membership Pass foundation.
-- WalletCredential: long-lived, opaque, member-identity credential (Apple Wallet / Google
-- Wallet / in-app "Mi Pase"). Never authoritative on its own — every scan re-runs live
-- GymOS booking-eligibility authorization. Only SHA-256(rawCredential) is ever persisted;
-- the raw value is generated once at issuance and never written to this table.
--
-- Hand-authored (not `prisma migrate dev`-generated): this repo's shadow-database replay
-- currently fails on an earlier historical migration (P3006 against a clean shadow DB),
-- so this file was written directly, matching this repo's established migration.sql style
-- (see e.g. 20260606000000_phase25_day_pass) and applied via `prisma migrate deploy`
-- (which does not require a shadow database).

-- CreateTable
CREATE TABLE "wallet_credentials" (
    "id"              TEXT         NOT NULL,
    "studio_id"       TEXT         NOT NULL,
    "user_id"         TEXT         NOT NULL,
    "credential_hash" TEXT         NOT NULL,
    "revoked_at"      TIMESTAMP(3),
    "last_used_at"    TIMESTAMP(3),
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_credentials_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "wallet_credentials" ADD CONSTRAINT "wallet_credentials_studio_id_fkey"
    FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_credentials" ADD CONSTRAINT "wallet_credentials_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex (unique: hash lookup at scan time is the hot path)
CREATE UNIQUE INDEX "wallet_credentials_credential_hash_key"
    ON "wallet_credentials"("credential_hash");

-- CreateIndex (studioId + userId — issuance/lookup queries)
CREATE INDEX "wallet_credentials_studio_id_user_id_idx"
    ON "wallet_credentials"("studio_id", "user_id");

-- CreateIndex (studioId — studio-scoped listing/admin queries)
CREATE INDEX "wallet_credentials_studio_id_idx"
    ON "wallet_credentials"("studio_id");

-- CreatePartialUniqueIndex (CTO Correction 1 invariant: at most one ACTIVE credential per
-- member per studio. Prisma's schema DSL has no `WHERE` clause for @@unique, so this index
-- exists only here, not as a second @@unique in schema.prisma — the schema's plain
-- @@index([studioId, userId]) above documents the shape; this index enforces the invariant.
-- Revoked rows (revoked_at IS NOT NULL) are excluded and never collide, so reissue
-- (revoke old -> issue new) is always safe even before the old row's revocation is visible
-- to a racing transaction, because the racing transaction's revoke commits first inside the
-- same advisory-locked transaction as the new insert — see WalletCredentialService.reissue.
CREATE UNIQUE INDEX "wallet_credentials_one_active_per_member"
    ON "wallet_credentials"("studio_id", "user_id")
    WHERE "revoked_at" IS NULL;
