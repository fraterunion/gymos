-- ARES GymOS — READ-ONLY grandfathering preflight.
-- Safe to run on a production READ-ONLY connection or a fresh Neon branch.
-- Do not execute mutation statements; no Stripe API calls from this file.
-- Re-run immediately before the price-lock migration and review the output.
-- The production migration initializes CASH locks from current catalog to
-- preserve existing renewal behavior; STRIPE uses the latest captured
-- succeeded payment (fallback catalog), verified against live Stripe prices.
--
-- 1. Inventory by payment source/status and fallback risk.
WITH latest AS (
  SELECT DISTINCT ON (subscription_id) subscription_id, amount_cents
  FROM payments
  WHERE subscription_id IS NOT NULL AND status = 'SUCCEEDED'
  ORDER BY subscription_id, created_at DESC, id DESC
)
SELECT s.source::text AS source, s.status::text AS status,
       COUNT(*)::bigint AS subscription_count,
       COUNT(*) FILTER (WHERE latest.subscription_id IS NULL)::bigint AS without_succeeded_payment,
       COUNT(*) FILTER (
         WHERE latest.amount_cents IS NOT NULL AND latest.amount_cents <> mp.price_cents
       )::bigint AS latest_payment_differs_catalog
FROM subscriptions s
JOIN membership_plans mp ON mp.id = s.membership_plan_id
LEFT JOIN latest ON latest.subscription_id = s.id
GROUP BY s.source,s.status
ORDER BY s.source,s.status;

-- 2. CASH history diagnostics ONLY: one-off or overridden payments can differ
--    from the catalog. The migration does NOT use historical CASH payment
--    values as the new recurring price. The initial CASH lock is catalog.
--    Fer will choose a scope only when she changes catalog prices later.
WITH latest AS (
  SELECT DISTINCT ON (subscription_id) subscription_id, amount_cents
  FROM payments WHERE status='SUCCEEDED' AND subscription_id IS NOT NULL
  ORDER BY subscription_id, created_at DESC, id DESC
)
SELECT mp.name AS plan, mp.currency, mp.price_cents AS catalog_cents,
       latest.amount_cents AS historical_cash_payment_cents,
       COUNT(*)::bigint AS active_cash_members
FROM subscriptions s
JOIN membership_plans mp ON mp.id = s.membership_plan_id
JOIN latest ON latest.subscription_id = s.id
WHERE s.source = 'CASH' AND s.status='ACTIVE'
  AND latest.amount_cents <> mp.price_cents
GROUP BY mp.name,mp.currency,mp.price_cents,latest.amount_cents
ORDER BY mp.name,historical_cash_payment_cents;

-- 3. Stripe subscriptions requiring a live Stripe subscription-price lookup.
SELECT s.status::text AS status,
       COUNT(*)::bigint AS stripe_rows_without_local_payment
FROM subscriptions s
WHERE s.source='STRIPE'
 AND NOT EXISTS(
   SELECT 1 FROM payments p
   WHERE p.subscription_id=s.id AND p.status='SUCCEEDED'
 )
GROUP BY s.status ORDER BY s.status;

-- 4. Compare capture-order price and effective-paid-date price. Backdated
--    payments must not cause a newly recorded transaction to be ignored.
WITH captured AS (
  SELECT DISTINCT ON (subscription_id) subscription_id,amount_cents
  FROM payments WHERE status='SUCCEEDED' AND subscription_id IS NOT NULL
  ORDER BY subscription_id,created_at DESC,id DESC
),effective AS (
  SELECT DISTINCT ON (subscription_id) subscription_id,amount_cents
  FROM payments WHERE status='SUCCEEDED' AND subscription_id IS NOT NULL
  ORDER BY subscription_id,COALESCE(paid_at,created_at) DESC,id DESC
)
SELECT COUNT(*)::bigint AS differing_price_locks
FROM captured c
JOIN effective e USING (subscription_id)
WHERE c.amount_cents IS DISTINCT FROM e.amount_cents;
