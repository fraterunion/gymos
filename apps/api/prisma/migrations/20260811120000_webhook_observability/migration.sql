-- Phase 29: Webhook Observability
-- Adds attempt tracking and error capture to stripe_webhook_events.
-- Rows with processed=false AND attempt_count >= 3 after 24h are "dead letters".

ALTER TABLE "stripe_webhook_events"
  ADD COLUMN IF NOT EXISTS "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_attempt_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "last_error" TEXT;

-- Backfill: existing unprocessed rows get attempt_count=1 to mark them as having
-- been attempted at least once (they arrived and triggered processing).
UPDATE "stripe_webhook_events"
  SET "attempt_count" = 1, "last_attempt_at" = "created_at"
  WHERE "processed" = false AND "attempt_count" = 0;
