-- MM-4 — Multi-membership constraint swap. Replaces the legacy physical invariant
--   one ACTIVE   per (studio, user)   [subscriptions_one_active_per_user_per_studio_idx]
--   one SCHEDULED per (studio, user)  [subscriptions_one_scheduled_per_user_per_studio_idx]
-- with the family-scoped invariant that supports compatible simultaneous memberships:
--   one renewable  per (studio, user, plan)                      [renewable = ACTIVE/TRIALING/PAST_DUE/PAUSED]
--   one renewable  per (studio, user, non-null exclusive_group_key)
--   one SCHEDULED  per (studio, user, plan)
--   one SCHEDULED  per (studio, user, non-null exclusive_group_key)
--
-- SCHEDULED rows deliberately do NOT conflict with renewable rows: an ACTIVE Stripe
-- subscription plus its SCHEDULED cash successor for the same plan is the designed
-- Stripe→Cash period-end transition state.
--
-- FAIL CLOSED: the assertions below abort the whole transaction on any state the new
-- indexes could not accept (or that violates the MM rollout preconditions), leaving the
-- legacy indexes fully intact. This migration never deletes or updates any row and never
-- rewrites historical billing facts — it is index DDL only.
--
-- Rollback: see down.sql in this directory (manual, gated — never run automatically).

DO $$
DECLARE
  v_count bigint;
BEGIN
  -- B1: duplicate renewable rows per member + plan
  SELECT COUNT(*) INTO v_count FROM (
    SELECT 1 FROM "subscriptions"
    WHERE "status" IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED')
    GROUP BY "studio_id", "user_id", "membership_plan_id"
    HAVING COUNT(*) > 1
  ) d;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MM-4 preflight B1: % member/plan pair(s) hold more than one renewable subscription — resolve before the constraint swap', v_count;
  END IF;

  -- B2: duplicate renewable rows per member + non-null exclusive group
  SELECT COUNT(*) INTO v_count FROM (
    SELECT 1 FROM "subscriptions"
    WHERE "status" IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED')
      AND "exclusive_group_key" IS NOT NULL
    GROUP BY "studio_id", "user_id", "exclusive_group_key"
    HAVING COUNT(*) > 1
  ) d;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MM-4 preflight B2: % member/group pair(s) hold more than one renewable subscription in the same exclusive group', v_count;
  END IF;

  -- B3: duplicate SCHEDULED rows per member + plan
  SELECT COUNT(*) INTO v_count FROM (
    SELECT 1 FROM "subscriptions"
    WHERE "status" = 'SCHEDULED'
    GROUP BY "studio_id", "user_id", "membership_plan_id"
    HAVING COUNT(*) > 1
  ) d;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MM-4 preflight B3: % member/plan pair(s) hold more than one SCHEDULED subscription', v_count;
  END IF;

  -- B4: duplicate SCHEDULED rows per member + non-null exclusive group
  SELECT COUNT(*) INTO v_count FROM (
    SELECT 1 FROM "subscriptions"
    WHERE "status" = 'SCHEDULED'
      AND "exclusive_group_key" IS NOT NULL
    GROUP BY "studio_id", "user_id", "exclusive_group_key"
    HAVING COUNT(*) > 1
  ) d;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MM-4 preflight B4: % member/group pair(s) hold more than one SCHEDULED subscription in the same exclusive group', v_count;
  END IF;

  -- B5: live rows missing the purchase-time snapshot. The MM-1 backfill guarantees every
  -- row a snapshot and no plan is stackable before this swap, so any NULL here means the
  -- rollout preconditions are broken.
  SELECT COUNT(*) INTO v_count FROM "subscriptions"
  WHERE "status" IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED','SCHEDULED')
    AND "exclusive_group_key" IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MM-4 preflight B5: % live subscription row(s) have no exclusive_group_key snapshot', v_count;
  END IF;

  -- B6: live snapshot/plan mismatch. Before the (later, separately gated) Booty
  -- stackable stage, every live row snapshot must equal the plan current group —
  -- a mismatch means plan exclusivity was edited outside the gated process.
  SELECT COUNT(*) INTO v_count
  FROM "subscriptions" s
  JOIN "membership_plans" mp ON mp."id" = s."membership_plan_id"
  WHERE s."status" IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED','SCHEDULED')
    AND s."exclusive_group_key" IS DISTINCT FROM mp."exclusive_group";
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MM-4 preflight B6: % live subscription row(s) whose snapshot differs from the plan exclusive_group', v_count;
  END IF;

  -- B7: STRIPE-source renewable rows without a Stripe subscription id (corrupt provider state)
  SELECT COUNT(*) INTO v_count FROM "subscriptions"
  WHERE "source" = 'STRIPE'
    AND "stripe_subscription_id" IS NULL
    AND "status" IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED');
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MM-4 preflight B7: % renewable STRIPE row(s) missing stripe_subscription_id', v_count;
  END IF;

  -- B8: plan configuration — before the Booty stackable stage, every non-deleted plan
  -- must still carry a non-null exclusive_group (the MM-1 backfill set them all to CORE).
  SELECT COUNT(*) INTO v_count FROM "membership_plans"
  WHERE "deleted_at" IS NULL
    AND "exclusive_group" IS NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MM-4 preflight B8: % non-deleted plan(s) have a NULL exclusive_group before the gated stackable stage', v_count;
  END IF;
END
$$;

-- New family-scoped unique indexes — created BEFORE the legacy indexes are dropped so
-- no committed state is ever under weaker-than-final protection.
CREATE UNIQUE INDEX "subscriptions_one_renewable_per_member_plan_idx"
  ON "subscriptions" ("studio_id", "user_id", "membership_plan_id")
  WHERE "status" IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED');

CREATE UNIQUE INDEX "subscriptions_one_renewable_per_member_group_idx"
  ON "subscriptions" ("studio_id", "user_id", "exclusive_group_key")
  WHERE "status" IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED')
    AND "exclusive_group_key" IS NOT NULL;

CREATE UNIQUE INDEX "subscriptions_one_scheduled_per_member_plan_idx"
  ON "subscriptions" ("studio_id", "user_id", "membership_plan_id")
  WHERE "status" = 'SCHEDULED';

CREATE UNIQUE INDEX "subscriptions_one_scheduled_per_member_group_idx"
  ON "subscriptions" ("studio_id", "user_id", "exclusive_group_key")
  WHERE "status" = 'SCHEDULED'
    AND "exclusive_group_key" IS NOT NULL;

-- Legacy member-scoped indexes retired.
DROP INDEX "subscriptions_one_active_per_user_per_studio_idx";
DROP INDEX "subscriptions_one_scheduled_per_user_per_studio_idx";
