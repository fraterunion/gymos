-- Fix: Pro plan class_credits null → 5
-- The Pro plan was created directly in production with class_credits = null (unlimited).
-- The correct entitlement is 5 classes per subscription period.
-- Verified: all 4 active Pro subscribers are under 5 classes in their current period.
-- No grandfathering required. No existing bookings are affected by this change.
-- Plan ID confirmed read-only from production: cmqzn1r95003zqo0rh16v6nbf

UPDATE "membership_plans"
SET "class_credits" = 5
WHERE "id" = 'cmqzn1r95003zqo0rh16v6nbf'
  AND "name" = 'Pro'
  AND "class_credits" IS NULL;
