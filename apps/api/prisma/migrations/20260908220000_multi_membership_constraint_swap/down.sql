-- MM-4 constraint swap — ROLLBACK (manual, gated; Prisma never runs this file).
--
-- ONLY valid BEFORE the first legitimate dual membership exists. Once any member holds
-- two renewable memberships, the legacy one-ACTIVE-per-member index cannot be recreated
-- without first remediating those members (a manual, member-by-member business decision —
-- NEVER automatic). The assertions below fail closed in that case.
--
-- Run inside a single transaction:  BEGIN; \i down.sql; COMMIT;

DO $$
DECLARE
  v_count bigint;
BEGIN
  -- More than one renewable membership per member (any plan/group) — dual membership
  -- data exists; structural rollback is forbidden without explicit remediation.
  SELECT COUNT(*) INTO v_count FROM (
    SELECT 1 FROM "subscriptions"
    WHERE "status" IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED')
    GROUP BY "studio_id", "user_id"
    HAVING COUNT(*) > 1
  ) d;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MM-4 rollback blocked: % member(s) hold more than one renewable membership — remediate manually before recreating the legacy indexes', v_count;
  END IF;

  -- More than one ACTIVE per member (subset of the above, asserted explicitly because it
  -- is the exact predicate of the legacy ACTIVE index).
  SELECT COUNT(*) INTO v_count FROM (
    SELECT 1 FROM "subscriptions"
    WHERE "status" = 'ACTIVE'
    GROUP BY "studio_id", "user_id"
    HAVING COUNT(*) > 1
  ) d;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MM-4 rollback blocked: % member(s) hold more than one ACTIVE membership', v_count;
  END IF;

  -- More than one SCHEDULED per member — the exact predicate of the legacy SCHEDULED index.
  SELECT COUNT(*) INTO v_count FROM (
    SELECT 1 FROM "subscriptions"
    WHERE "status" = 'SCHEDULED'
    GROUP BY "studio_id", "user_id"
    HAVING COUNT(*) > 1
  ) d;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MM-4 rollback blocked: % member(s) hold more than one SCHEDULED subscription', v_count;
  END IF;
END
$$;

CREATE UNIQUE INDEX "subscriptions_one_active_per_user_per_studio_idx"
  ON "subscriptions" ("studio_id", "user_id")
  WHERE "status" = 'ACTIVE'::"SubscriptionStatus";

CREATE UNIQUE INDEX "subscriptions_one_scheduled_per_user_per_studio_idx"
  ON "subscriptions" ("studio_id", "user_id")
  WHERE "status" = 'SCHEDULED'::"SubscriptionStatus";

DROP INDEX "subscriptions_one_renewable_per_member_plan_idx";
DROP INDEX "subscriptions_one_renewable_per_member_group_idx";
DROP INDEX "subscriptions_one_scheduled_per_member_plan_idx";
DROP INDEX "subscriptions_one_scheduled_per_member_group_idx";
