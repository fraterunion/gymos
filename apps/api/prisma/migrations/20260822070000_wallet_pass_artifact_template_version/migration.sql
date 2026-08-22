-- Purely additive. Both columns are nullable/defaulted, so the currently deployed API keeps
-- running unchanged against this schema.
--
-- template_version is deliberately left NULL for every existing row: those artifacts were
-- signed before presentation versioning existed, so "unknown" is the truthful value and the
-- application treats it as stale, rebuilding them from the same WalletCredential on next access.
ALTER TABLE "wallet_pass_artifacts" ADD COLUMN "template_version" INTEGER;

-- Existing rows adopt their created_at so the column is never null, while new rows are
-- maintained by Prisma's @updatedAt.
ALTER TABLE "wallet_pass_artifacts" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "wallet_pass_artifacts" SET "updated_at" = "created_at";
