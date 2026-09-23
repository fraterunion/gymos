-- Day Pass purchase lifecycle hardening. ADDITIVE ONLY.
-- Adds attempt-telemetry columns to day_passes; every column is nullable or defaulted, so
-- existing rows need no backfill, the previous API build keeps working against this schema
-- (rollback-safe), and the Railway "prisma migrate deploy && start" boot applies it without
-- locking rewrites (Postgres adds nullable / constant-default columns without a table rewrite).
-- No enum values are added; no index or constraint is dropped or changed; no rows are touched.

ALTER TABLE "day_passes"
    ADD COLUMN "previous_stripe_payment_intent_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "attempt_count"              INTEGER      NOT NULL DEFAULT 1,
    ADD COLUMN "last_attempt_at"            TIMESTAMP(3),
    ADD COLUMN "last_stripe_status"         TEXT,
    ADD COLUMN "last_payment_error_code"    TEXT,
    ADD COLUMN "last_payment_decline_code"  TEXT,
    ADD COLUMN "activated_at"               TIMESTAMP(3),
    ADD COLUMN "expired_at"                 TIMESTAMP(3);
