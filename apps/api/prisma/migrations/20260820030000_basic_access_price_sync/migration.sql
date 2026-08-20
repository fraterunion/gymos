-- Stripe price_1TiPaiGuUoCXNOREdIeDGSgc is already the authoritative
-- MXN 1,300/month Basic Access Price. Correct only the stale GymOS display value.
UPDATE "membership_plans"
SET "price_cents" = 130000,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'cmq1y1sqe000xenswkzsfwq28'
  AND "name" = 'Basic Access'
  AND "currency" = 'mxn'
  AND "billing_interval" = 'MONTHLY'
  AND "stripe_price_id" = 'price_1TiPaiGuUoCXNOREdIeDGSgc'
  AND "price_cents" = 100000;
