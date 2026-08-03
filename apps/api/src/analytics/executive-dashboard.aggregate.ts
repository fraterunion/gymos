import { Prisma, SubscriptionStatus } from '@prisma/client';
import type { FinancialPeriodWindows } from './financial-period.utils';
import { SQL_SUBSCRIPTION_USER_EXCLUDE } from './analytics-exclusion.utils';

export type ExecutiveFinancialCoreRow = {
  today_cents: bigint;
  month_cents: bigint;
  prev_month_cents: bigint;
  month_payment_count: bigint;
  month_stripe_cents: bigint;
  month_cash_cents: bigint;
  month_other_cents: bigint;
  subscriptions_cents: bigint;
  one_time_cents: bigint;
  other_breakdown_cents: bigint;
  lifetime_cents: bigint;
  failed_today: bigint;
  failed_30d: bigint;
  last_payment_at: Date | null;
  revenue_30d_cents: bigint;
};

export type ExecutiveMonthTrendRow = {
  d: Date;
  amount_cents: bigint;
  payment_count: bigint;
};

export type ExecutivePlanAttributionRow = {
  plan_id: string | null;
  plan_name: string | null;
  revenue_cents: bigint;
};

export type ExecutiveMembershipStatsRow = {
  active_members: bigint;
  new_members_30d: bigint;
  prev_new_members_30d: bigint;
  cancellations_30d: bigint;
  inactive_21d: bigint;
  subs_missing_stripe: bigint;
  active_stripe_no_payment: bigint;
};

export type ExecutiveOperationsRow = {
  classes_today: bigint;
  checkins_today: bigint;
  booked_today: bigint;
  capacity_today: bigint;
};

export type ExecutiveTopMembersRow = {
  top_today_user_id: string | null;
  top_today_first: string | null;
  top_today_last: string | null;
  top_today_cents: bigint | null;
  top_lifetime_user_id: string | null;
  top_lifetime_first: string | null;
  top_lifetime_last: string | null;
  top_lifetime_cents: bigint | null;
  most_active_user_id: string | null;
  most_active_first: string | null;
  most_active_last: string | null;
  most_active_visits: bigint | null;
};

/** Bounded query helpers — each function is exactly one DB round-trip. */
export const EXECUTIVE_QUERY_BUDGET = 21 as const;

export function sqlFinancialCore(
  studioId: string,
  todayStart: Date,
  now: Date,
  monthWindows: FinancialPeriodWindows,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      COALESCE(SUM(CASE
        WHEN status = 'SUCCEEDED'
         AND COALESCE(paid_at, created_at) >= ${todayStart}
         AND COALESCE(paid_at, created_at) <= ${now}
        THEN amount_cents END), 0)::bigint AS today_cents,
      COALESCE(SUM(CASE
        WHEN status = 'SUCCEEDED'
         AND COALESCE(paid_at, created_at) >= ${monthWindows.periodStart}
         AND COALESCE(paid_at, created_at) <= ${monthWindows.periodEnd}
        THEN amount_cents END), 0)::bigint AS month_cents,
      COALESCE(SUM(CASE
        WHEN status = 'SUCCEEDED'
         AND COALESCE(paid_at, created_at) >= ${monthWindows.prevPeriodStart}
         AND COALESCE(paid_at, created_at) <= ${monthWindows.prevPeriodEnd}
        THEN amount_cents END), 0)::bigint AS prev_month_cents,
      COUNT(CASE
        WHEN status = 'SUCCEEDED'
         AND COALESCE(paid_at, created_at) >= ${monthWindows.periodStart}
         AND COALESCE(paid_at, created_at) <= ${monthWindows.periodEnd}
        THEN 1 END)::bigint AS month_payment_count,
      COALESCE(SUM(CASE
        WHEN status = 'SUCCEEDED'
         AND COALESCE(paid_at, created_at) >= ${monthWindows.periodStart}
         AND COALESCE(paid_at, created_at) <= ${monthWindows.periodEnd}
         AND payment_method IN ('STRIPE', 'TERMINAL')
        THEN amount_cents END), 0)::bigint AS month_stripe_cents,
      COALESCE(SUM(CASE
        WHEN status = 'SUCCEEDED'
         AND COALESCE(paid_at, created_at) >= ${monthWindows.periodStart}
         AND COALESCE(paid_at, created_at) <= ${monthWindows.periodEnd}
         AND payment_method = 'CASH'
        THEN amount_cents END), 0)::bigint AS month_cash_cents,
      COALESCE(SUM(CASE
        WHEN status = 'SUCCEEDED'
         AND COALESCE(paid_at, created_at) >= ${monthWindows.periodStart}
         AND COALESCE(paid_at, created_at) <= ${monthWindows.periodEnd}
         AND payment_method NOT IN ('STRIPE', 'TERMINAL', 'CASH')
        THEN amount_cents END), 0)::bigint AS month_other_cents,
      COALESCE(SUM(CASE
        WHEN status = 'SUCCEEDED'
         AND COALESCE(paid_at, created_at) >= ${monthWindows.periodStart}
         AND COALESCE(paid_at, created_at) <= ${monthWindows.periodEnd}
         AND subscription_id IS NOT NULL
        THEN amount_cents END), 0)::bigint AS subscriptions_cents,
      COALESCE(SUM(CASE
        WHEN status = 'SUCCEEDED'
         AND COALESCE(paid_at, created_at) >= ${monthWindows.periodStart}
         AND COALESCE(paid_at, created_at) <= ${monthWindows.periodEnd}
         AND subscription_id IS NULL AND membership_plan_id IS NOT NULL
        THEN amount_cents END), 0)::bigint AS one_time_cents,
      COALESCE(SUM(CASE
        WHEN status = 'SUCCEEDED'
         AND COALESCE(paid_at, created_at) >= ${monthWindows.periodStart}
         AND COALESCE(paid_at, created_at) <= ${monthWindows.periodEnd}
         AND subscription_id IS NULL AND membership_plan_id IS NULL
        THEN amount_cents END), 0)::bigint AS other_breakdown_cents,
      COALESCE(SUM(CASE WHEN status = 'SUCCEEDED' THEN amount_cents END), 0)::bigint AS lifetime_cents,
      COUNT(CASE
        WHEN status = 'FAILED'
         AND created_at >= ${todayStart}
        THEN 1 END)::bigint AS failed_today,
      COUNT(CASE
        WHEN status = 'FAILED'
         AND created_at >= ${new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)}
        THEN 1 END)::bigint AS failed_30d,
      MAX(CASE WHEN status = 'SUCCEEDED' THEN COALESCE(paid_at, created_at) END) AS last_payment_at,
      COALESCE(SUM(CASE
        WHEN status = 'SUCCEEDED'
         AND COALESCE(paid_at, created_at) >= ${new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)}
        THEN amount_cents END), 0)::bigint AS revenue_30d_cents
    FROM payments
    WHERE studio_id = ${studioId}
  `;
}

export function sqlMonthTrend(
  studioId: string,
  monthWindows: FinancialPeriodWindows,
  timezone: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      (COALESCE(paid_at, created_at) AT TIME ZONE ${timezone})::date AS d,
      COALESCE(SUM(amount_cents), 0)::bigint AS amount_cents,
      COUNT(*)::bigint AS payment_count
    FROM payments
    WHERE studio_id = ${studioId}
      AND status = 'SUCCEEDED'
      AND COALESCE(paid_at, created_at) >= ${monthWindows.periodStart}
      AND COALESCE(paid_at, created_at) <= ${monthWindows.periodEnd}
    GROUP BY 1
    ORDER BY 1
  `;
}

export function sqlPlanAttributionMonth(
  studioId: string,
  monthWindows: FinancialPeriodWindows,
): Prisma.Sql {
  return Prisma.sql`
    WITH pay AS (
      SELECT user_id, SUM(amount_cents)::bigint AS cents
      FROM payments
      WHERE studio_id = ${studioId}
        AND status = 'SUCCEEDED'
        AND COALESCE(paid_at, created_at) >= ${monthWindows.periodStart}
        AND COALESCE(paid_at, created_at) <= ${monthWindows.periodEnd}
      GROUP BY user_id
    ),
    sub_pick AS (
      SELECT DISTINCT ON (s.user_id)
        s.user_id,
        s.membership_plan_id
      FROM subscriptions s
      WHERE s.studio_id = ${studioId}
      ORDER BY s.user_id,
        CASE
          WHEN s.status IN ('ACTIVE', 'TRIALING') THEN 0
          WHEN s.status = 'PAST_DUE' THEN 1
          ELSE 2
        END,
        s.updated_at DESC
    )
    SELECT mp.id AS plan_id,
           mp.name AS plan_name,
           COALESCE(SUM(pay.cents), 0)::bigint AS revenue_cents
    FROM pay
    LEFT JOIN sub_pick sp ON sp.user_id = pay.user_id
    LEFT JOIN membership_plans mp ON mp.id = sp.membership_plan_id AND mp.studio_id = ${studioId}
    GROUP BY mp.id, mp.name
    ORDER BY revenue_cents DESC
  `;
}

export function sqlMembershipStats(
  studioId: string,
  now: Date,
  thirtyDaysAgo: Date,
  prevThirtyStart: Date,
  inactiveSince: Date,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      (SELECT COUNT(*)::bigint FROM studio_memberships sm
        WHERE sm.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.deleted_at IS NULL
          AND sm.exclude_from_analytics = false) AS active_members,
      (SELECT COUNT(*)::bigint FROM studio_memberships sm
        WHERE sm.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.deleted_at IS NULL
          AND sm.exclude_from_analytics = false
          AND sm.created_at >= ${thirtyDaysAgo}) AS new_members_30d,
      (SELECT COUNT(*)::bigint FROM studio_memberships sm
        WHERE sm.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.deleted_at IS NULL
          AND sm.exclude_from_analytics = false
          AND sm.created_at >= ${prevThirtyStart}
          AND sm.created_at < ${thirtyDaysAgo}) AS prev_new_members_30d,
      (SELECT COUNT(*)::bigint FROM subscriptions s
        WHERE s.studio_id = ${studioId}
          AND s.status = 'CANCELED'
          AND s.updated_at >= ${thirtyDaysAgo}
          ${SQL_SUBSCRIPTION_USER_EXCLUDE}) AS cancellations_30d,
      (SELECT COUNT(*)::bigint FROM studio_memberships sm
        WHERE sm.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.deleted_at IS NULL
          AND sm.exclude_from_analytics = false
          AND NOT EXISTS (
            SELECT 1 FROM attendances a
            WHERE a.studio_id = ${studioId}
              AND a.user_id = sm.user_id
              AND a.checked_in_at >= ${inactiveSince}
          )) AS inactive_21d,
      (SELECT COUNT(*)::bigint FROM subscriptions s
        WHERE s.studio_id = ${studioId}
          AND s.status IN ('ACTIVE', 'TRIALING', 'PAST_DUE')
          AND s.stripe_subscription_id IS NULL
          AND s.source = 'STRIPE'
          ${SQL_SUBSCRIPTION_USER_EXCLUDE}) AS subs_missing_stripe,
      (SELECT COUNT(*)::bigint FROM subscriptions s
        WHERE s.studio_id = ${studioId}
          AND s.status IN ('ACTIVE', 'TRIALING')
          AND s.stripe_subscription_id IS NOT NULL
          ${SQL_SUBSCRIPTION_USER_EXCLUDE}
          AND NOT EXISTS (
            SELECT 1 FROM payments p
            WHERE p.subscription_id = s.id AND p.status = 'SUCCEEDED'
          )) AS active_stripe_no_payment
  `;
}

export function sqlOperationsToday(
  studioId: string,
  todayStart: Date,
  tomorrowStart: Date,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      (SELECT COUNT(*)::bigint FROM scheduled_classes sc
        WHERE sc.studio_id = ${studioId}
          AND sc.starts_at >= ${todayStart}
          AND sc.starts_at < ${tomorrowStart}
          AND sc.status != 'CANCELLED') AS classes_today,
      (SELECT COUNT(*)::bigint FROM attendances a
        WHERE a.studio_id = ${studioId}
          AND a.checked_in_at >= ${todayStart}
          AND a.checked_in_at < ${tomorrowStart}) AS checkins_today,
      (SELECT COALESCE(SUM(b.c), 0)::bigint FROM scheduled_classes sc
        LEFT JOIN (
          SELECT scheduled_class_id, COUNT(*) AS c
          FROM bookings
          WHERE status IN ('CONFIRMED','COMPLETED','NO_SHOW')
          GROUP BY scheduled_class_id
        ) b ON b.scheduled_class_id = sc.id
        WHERE sc.studio_id = ${studioId}
          AND sc.starts_at >= ${todayStart}
          AND sc.starts_at < ${tomorrowStart}
          AND sc.status != 'CANCELLED') AS booked_today,
      (SELECT COALESCE(SUM(sc.capacity), 0)::bigint FROM scheduled_classes sc
        WHERE sc.studio_id = ${studioId}
          AND sc.starts_at >= ${todayStart}
          AND sc.starts_at < ${tomorrowStart}
          AND sc.status != 'CANCELLED') AS capacity_today
  `;
}

export function sqlTopMembers(
  studioId: string,
  todayStart: Date,
  monthStart: Date,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      (SELECT u.id FROM payments p
        INNER JOIN users u ON u.id = p.user_id
        WHERE p.studio_id = ${studioId} AND p.status = 'SUCCEEDED'
          AND COALESCE(p.paid_at, p.created_at) >= ${todayStart}
        GROUP BY u.id ORDER BY SUM(p.amount_cents) DESC LIMIT 1) AS top_today_user_id,
      (SELECT u.first_name FROM payments p
        INNER JOIN users u ON u.id = p.user_id
        WHERE p.studio_id = ${studioId} AND p.status = 'SUCCEEDED'
          AND COALESCE(p.paid_at, p.created_at) >= ${todayStart}
        GROUP BY u.id, u.first_name ORDER BY SUM(p.amount_cents) DESC LIMIT 1) AS top_today_first,
      (SELECT u.last_name FROM payments p
        INNER JOIN users u ON u.id = p.user_id
        WHERE p.studio_id = ${studioId} AND p.status = 'SUCCEEDED'
          AND COALESCE(p.paid_at, p.created_at) >= ${todayStart}
        GROUP BY u.id, u.last_name ORDER BY SUM(p.amount_cents) DESC LIMIT 1) AS top_today_last,
      (SELECT COALESCE(SUM(p.amount_cents), 0)::bigint FROM payments p
        WHERE p.studio_id = ${studioId} AND p.status = 'SUCCEEDED'
          AND COALESCE(p.paid_at, p.created_at) >= ${todayStart}
          AND p.user_id = (
            SELECT u.id FROM payments p2 INNER JOIN users u ON u.id = p2.user_id
            WHERE p2.studio_id = ${studioId} AND p2.status = 'SUCCEEDED'
              AND COALESCE(p2.paid_at, p2.created_at) >= ${todayStart}
            GROUP BY u.id ORDER BY SUM(p2.amount_cents) DESC LIMIT 1
          )) AS top_today_cents,
      (SELECT u.id FROM payments p
        INNER JOIN users u ON u.id = p.user_id
        WHERE p.studio_id = ${studioId} AND p.status = 'SUCCEEDED'
        GROUP BY u.id ORDER BY SUM(p.amount_cents) DESC LIMIT 1) AS top_lifetime_user_id,
      (SELECT u.first_name FROM payments p
        INNER JOIN users u ON u.id = p.user_id
        WHERE p.studio_id = ${studioId} AND p.status = 'SUCCEEDED'
        GROUP BY u.id, u.first_name ORDER BY SUM(p.amount_cents) DESC LIMIT 1) AS top_lifetime_first,
      (SELECT u.last_name FROM payments p
        INNER JOIN users u ON u.id = p.user_id
        WHERE p.studio_id = ${studioId} AND p.status = 'SUCCEEDED'
        GROUP BY u.id, u.last_name ORDER BY SUM(p.amount_cents) DESC LIMIT 1) AS top_lifetime_last,
      (SELECT COALESCE(SUM(p.amount_cents), 0)::bigint FROM payments p
        WHERE p.studio_id = ${studioId} AND p.status = 'SUCCEEDED'
          AND p.user_id = (
            SELECT u.id FROM payments p2 INNER JOIN users u ON u.id = p2.user_id
            WHERE p2.studio_id = ${studioId} AND p2.status = 'SUCCEEDED'
            GROUP BY u.id ORDER BY SUM(p2.amount_cents) DESC LIMIT 1
          )) AS top_lifetime_cents,
      (SELECT u.id FROM attendances a
        INNER JOIN users u ON u.id = a.user_id
        WHERE a.studio_id = ${studioId} AND a.checked_in_at >= ${monthStart}
        GROUP BY u.id ORDER BY COUNT(*) DESC LIMIT 1) AS most_active_user_id,
      (SELECT u.first_name FROM attendances a
        INNER JOIN users u ON u.id = a.user_id
        WHERE a.studio_id = ${studioId} AND a.checked_in_at >= ${monthStart}
        GROUP BY u.id, u.first_name ORDER BY COUNT(*) DESC LIMIT 1) AS most_active_first,
      (SELECT u.last_name FROM attendances a
        INNER JOIN users u ON u.id = a.user_id
        WHERE a.studio_id = ${studioId} AND a.checked_in_at >= ${monthStart}
        GROUP BY u.id, u.last_name ORDER BY COUNT(*) DESC LIMIT 1) AS most_active_last,
      (SELECT COUNT(*)::bigint FROM attendances a
        WHERE a.studio_id = ${studioId}
          AND a.user_id = (
            SELECT u.id FROM attendances a2 INNER JOIN users u ON u.id = a2.user_id
            WHERE a2.studio_id = ${studioId} AND a2.checked_in_at >= ${monthStart}
            GROUP BY u.id ORDER BY COUNT(*) DESC LIMIT 1
          )
          AND a.checked_in_at >= ${monthStart}) AS most_active_visits
  `;
}

export const MRR_ELIGIBLE_STATUSES: SubscriptionStatus[] = [SubscriptionStatus.ACTIVE];
