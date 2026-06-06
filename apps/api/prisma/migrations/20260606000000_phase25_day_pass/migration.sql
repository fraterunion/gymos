-- Phase 25: Day Pass — one-time date-scoped class access (non-subscription).
-- validForDate stores the UTC midnight of the CDMX calendar date.
-- e.g. "June 10 CDMX" (UTC-6) is stored as 2026-06-10T06:00:00Z.

-- CreateEnum
CREATE TYPE "DayPassStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'REFUNDED');

-- CreateTable
CREATE TABLE "day_passes" (
    "id"                          TEXT              NOT NULL,
    "studio_id"                   TEXT              NOT NULL,
    "user_id"                     TEXT              NOT NULL,
    "valid_for_date"              TIMESTAMP(3)      NOT NULL,
    "price_cents"                 INTEGER           NOT NULL,
    "currency"                    TEXT              NOT NULL DEFAULT 'mxn',
    "status"                      "DayPassStatus"   NOT NULL DEFAULT 'PENDING',
    "stripe_checkout_session_id"  TEXT,
    "stripe_payment_intent_id"    TEXT,
    "created_at"                  TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                  TIMESTAMP(3)      NOT NULL,

    CONSTRAINT "day_passes_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "day_passes" ADD CONSTRAINT "day_passes_studio_id_fkey"
    FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_passes" ADD CONSTRAINT "day_passes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex (unique: stripe_checkout_session_id)
CREATE UNIQUE INDEX "day_passes_stripe_checkout_session_id_key"
    ON "day_passes"("stripe_checkout_session_id");

-- CreateIndex (unique: stripe_payment_intent_id)
CREATE UNIQUE INDEX "day_passes_stripe_payment_intent_id_key"
    ON "day_passes"("stripe_payment_intent_id");

-- CreateIndex (unique: one pass per user per studio per calendar day)
CREATE UNIQUE INDEX "day_passes_studio_id_user_id_valid_for_date_key"
    ON "day_passes"("studio_id", "user_id", "valid_for_date");

-- CreateIndex (studioId + userId — booking guard lookup)
CREATE INDEX "day_passes_studio_id_user_id_idx"
    ON "day_passes"("studio_id", "user_id");

-- CreateIndex (studioId + validForDate — availability queries)
CREATE INDEX "day_passes_studio_id_valid_for_date_idx"
    ON "day_passes"("studio_id", "valid_for_date");

-- CreateIndex (status — expiry sweep queries)
CREATE INDEX "day_passes_status_idx"
    ON "day_passes"("status");
