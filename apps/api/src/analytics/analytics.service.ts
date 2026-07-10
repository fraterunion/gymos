import { Injectable } from '@nestjs/common';
import {
  BillingInterval,
  BookingStatus,
  ClassStatus,
  EnrollmentFeeStatus,
  PaymentMethod,
  PaymentStatus,
  Role,
  SubscriptionStatus,
  WaitlistStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function monthlyEquivalentCents(priceCents: number, interval: BillingInterval): number {
  switch (interval) {
    case BillingInterval.MONTHLY:
      return priceCents;
    case BillingInterval.YEARLY:
      return Math.round(priceCents / 12);
    case BillingInterval.WEEKLY:
      return Math.round((priceCents * 52) / 12);
    default:
      return priceCents;
  }
}

function isDemoStripePayment(pi: string | null, inv: string | null): boolean {
  const p = (pi ?? '').toLowerCase();
  const i = (inv ?? '').toLowerCase();
  return p.includes('demo') || i.includes('demo') || (p === '' && i === '');
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(studioId: string) {
    const now = new Date();

    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      activeMembers,
      checkInsToday,
      upcomingClassesToday,
      waitlistCount,
      bookingsLast7d,
      noShowData,
      avgFillResult,
      todayOccupancyResult,
      popularTemplateResult,
      activeCoachResult,
    ] = await Promise.all([
      this.prisma.studioMembership.count({
        where: { studioId, deletedAt: null, user: { deletedAt: null } },
      }),

      this.prisma.attendance.count({
        where: { studioId, checkedInAt: { gte: todayStart, lt: tomorrowStart } },
      }),

      this.prisma.scheduledClass.count({
        where: {
          studioId,
          status: ClassStatus.SCHEDULED,
          startsAt: { gte: now, lt: tomorrowStart },
        },
      }),

      this.prisma.waitlistEntry.count({
        where: { studioId, status: WaitlistStatus.WAITING },
      }),

      this.prisma.booking.count({
        where: {
          studioId,
          createdAt: { gte: sevenDaysAgo },
          status: { not: BookingStatus.CANCELLED },
        },
      }),

      this.prisma.$queryRaw<{ no_show: bigint; total: bigint }[]>`
        SELECT
          COUNT(*) FILTER (WHERE b.status = 'NO_SHOW') AS no_show,
          COUNT(*) FILTER (WHERE b.status IN ('CONFIRMED','NO_SHOW','COMPLETED')) AS total
        FROM bookings b
        JOIN scheduled_classes sc ON sc.id = b.scheduled_class_id
        WHERE b.studio_id = ${studioId}
          AND sc.starts_at < ${now}
          AND sc.starts_at >= ${thirtyDaysAgo}
      `,

      this.prisma.$queryRaw<{ avg_fill: number | null }[]>`
        SELECT AVG(
          CASE WHEN sc.capacity > 0
          THEN CAST(COALESCE(b.confirmed_count, 0) AS float) / sc.capacity * 100
          ELSE NULL END
        ) AS avg_fill
        FROM scheduled_classes sc
        LEFT JOIN (
          SELECT scheduled_class_id, COUNT(*) AS confirmed_count
          FROM bookings
          WHERE status IN ('CONFIRMED','COMPLETED','NO_SHOW')
          GROUP BY scheduled_class_id
        ) b ON b.scheduled_class_id = sc.id
        WHERE sc.studio_id = ${studioId}
          AND sc.starts_at >= ${thirtyDaysAgo}
          AND sc.status != 'CANCELLED'
      `,

      this.prisma.$queryRaw<{ occupancy: number | null }[]>`
        SELECT AVG(
          CASE WHEN sc.capacity > 0
          THEN CAST(COALESCE(b.confirmed_count, 0) AS float) / sc.capacity * 100
          ELSE NULL END
        ) AS occupancy
        FROM scheduled_classes sc
        LEFT JOIN (
          SELECT scheduled_class_id, COUNT(*) AS confirmed_count
          FROM bookings
          WHERE status IN ('CONFIRMED','COMPLETED','NO_SHOW')
          GROUP BY scheduled_class_id
        ) b ON b.scheduled_class_id = sc.id
        WHERE sc.studio_id = ${studioId}
          AND sc.starts_at >= ${todayStart}
          AND sc.starts_at < ${tomorrowStart}
          AND sc.status != 'CANCELLED'
      `,

      this.prisma.$queryRaw<
        { id: string; name: string; color: string | null; booking_count: bigint }[]
      >`
        SELECT ct.id, ct.name, ct.color, COUNT(b.id) AS booking_count
        FROM class_templates ct
        JOIN scheduled_classes sc ON sc.class_template_id = ct.id
        JOIN bookings b ON b.scheduled_class_id = sc.id
        WHERE ct.studio_id = ${studioId}
          AND b.created_at >= ${thirtyDaysAgo}
          AND b.status NOT IN ('CANCELLED')
        GROUP BY ct.id, ct.name, ct.color
        ORDER BY booking_count DESC
        LIMIT 1
      `,

      this.prisma.$queryRaw<
        { id: string; first_name: string; last_name: string; class_count: bigint }[]
      >`
        SELECT u.id, u.first_name, u.last_name, COUNT(sc.id) AS class_count
        FROM users u
        JOIN scheduled_classes sc ON sc.instructor_id = u.id
        WHERE sc.studio_id = ${studioId}
          AND sc.starts_at >= ${thirtyDaysAgo}
          AND sc.status != 'CANCELLED'
        GROUP BY u.id, u.first_name, u.last_name
        ORDER BY class_count DESC
        LIMIT 1
      `,
    ]);

    const noShowRow = noShowData[0];
    const noShowTotal = Number(noShowRow?.total ?? 0);
    const noShowRate = noShowTotal > 0 ? (Number(noShowRow.no_show) / noShowTotal) * 100 : 0;

    const avgFillRaw = avgFillResult[0]?.avg_fill;
    const avgClassFill = typeof avgFillRaw === 'number' ? avgFillRaw : 0;

    const occupancyRaw = todayOccupancyResult[0]?.occupancy;
    const occupancyRateToday = typeof occupancyRaw === 'number' ? occupancyRaw : 0;

    const popularRow = popularTemplateResult[0];
    const mostPopularTemplate = popularRow
      ? {
          id: popularRow.id,
          name: popularRow.name,
          color: popularRow.color,
          bookingCount: Number(popularRow.booking_count),
        }
      : null;

    const coachRow = activeCoachResult[0];
    const mostActiveCoach = coachRow
      ? {
          id: coachRow.id,
          firstName: coachRow.first_name,
          lastName: coachRow.last_name,
          classCount: Number(coachRow.class_count),
        }
      : null;

    return {
      activeMembers,
      checkInsToday,
      upcomingClassesToday,
      occupancyRateToday: Math.round(occupancyRateToday * 10) / 10,
      waitlistCount,
      noShowRate: Math.round(noShowRate * 10) / 10,
      avgClassFill: Math.round(avgClassFill * 10) / 10,
      bookingsLast7d,
      mostPopularTemplate,
      mostActiveCoach,
      generatedAt: now.toISOString(),
    };
  }

  async getTrends(studioId: string, days: number) {
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [bookingRows, attendanceRows] = await Promise.all([
      this.prisma.$queryRaw<{ date: Date; count: bigint }[]>`
        SELECT date_trunc('day', created_at) AS date, COUNT(*) AS count
        FROM bookings
        WHERE studio_id = ${studioId}
          AND created_at >= ${since}
          AND status NOT IN ('CANCELLED')
        GROUP BY 1
        ORDER BY 1
      `,
      this.prisma.$queryRaw<{ date: Date; count: bigint }[]>`
        SELECT date_trunc('day', checked_in_at) AS date, COUNT(*) AS count
        FROM attendances
        WHERE studio_id = ${studioId}
          AND checked_in_at >= ${since}
        GROUP BY 1
        ORDER BY 1
      `,
    ]);

    // Build a complete day map, filling gaps with 0
    const dateMap = new Map<string, { bookings: number; attendances: number }>();
    for (let d = 0; d < days; d++) {
      const day = new Date(since.getTime() + d * 24 * 60 * 60 * 1000);
      const key = day.toISOString().split('T')[0]!;
      dateMap.set(key, { bookings: 0, attendances: 0 });
    }

    for (const row of bookingRows) {
      const key = new Date(row.date).toISOString().split('T')[0]!;
      const entry = dateMap.get(key);
      if (entry) entry.bookings = Number(row.count);
    }
    for (const row of attendanceRows) {
      const key = new Date(row.date).toISOString().split('T')[0]!;
      const entry = dateMap.get(key);
      if (entry) entry.attendances = Number(row.count);
    }

    const sorted = [...dateMap.entries()].sort(([a], [b]) => a.localeCompare(b));

    return {
      period: { from: since.toISOString(), to: now.toISOString(), days },
      bookings: sorted.map(([date, v]) => ({ date, count: v.bookings })),
      attendances: sorted.map(([date, v]) => ({ date, count: v.attendances })),
    };
  }

  async getClassBreakdown(studioId: string, days: number) {
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [topTemplates, peakHours] = await Promise.all([
      this.prisma.$queryRaw<
        { template_id: string; name: string; color: string | null; booking_count: bigint }[]
      >`
        SELECT ct.id AS template_id, ct.name, ct.color,
               COUNT(b.id) AS booking_count
        FROM class_templates ct
        JOIN scheduled_classes sc ON sc.class_template_id = ct.id
        LEFT JOIN bookings b
          ON b.scheduled_class_id = sc.id
         AND b.status NOT IN ('CANCELLED')
        WHERE ct.studio_id = ${studioId}
          AND ct.deleted_at IS NULL
          AND sc.starts_at >= ${since}
        GROUP BY ct.id, ct.name, ct.color
        ORDER BY booking_count DESC
        LIMIT 8
      `,
      this.prisma.$queryRaw<{ hour: number; count: bigint }[]>`
        SELECT EXTRACT(HOUR FROM sc.starts_at)::int AS hour,
               COUNT(b.id) AS count
        FROM scheduled_classes sc
        LEFT JOIN bookings b
          ON b.scheduled_class_id = sc.id
         AND b.status NOT IN ('CANCELLED')
        WHERE sc.studio_id = ${studioId}
          AND sc.starts_at >= ${since}
          AND sc.status != 'CANCELLED'
        GROUP BY 1
        ORDER BY 1
      `,
    ]);

    return {
      topTemplates: topTemplates.map((r) => ({
        templateId: r.template_id,
        name: r.name,
        color: r.color,
        bookingCount: Number(r.booking_count),
      })),
      peakHours: peakHours.map((r) => ({
        hour: r.hour,
        count: Number(r.count),
      })),
    };
  }

  /**
   * Revenue & retention (Phase 10B). All queries are scoped by `studioId`.
   */
  async getBusinessAnalytics(studioId: string) {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const tomorrowStart = new Date(now);
    tomorrowStart.setUTCHours(0, 0, 0, 0);
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
    const todayStart = new Date(tomorrowStart);
    todayStart.setUTCDate(todayStart.getUTCDate() - 1);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);
    const expiringBy = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [
      subscriptionStatusRows,
      mrrSubscriptions,
      memberCount,
      paymentMeta,
      revenueTrendRows,
      revenueTotalRow,
      repeatBookersRow,
      cancellations30Row,
      canceledTotalRow,
      bookingMixRows,
      revenueByPlanRows,
      unattributedRow,
      revenueTodayRow,
      revenueYesterdayRow,
      revenueByMethodRows,
      pendingRevenueRow,
      refundedRevenueRow,
      dayPassRevenueRow,
      newMembers30Row,
      newMembersPrev30Row,
      newSubscriptionsTodayRow,
      newSubscriptions30Row,
      membershipSalesTodayRow,
      enrollmentPaid30Row,
      foundersCountRow,
      inactiveMembersRow,
      waiversPendingRow,
      expiringMembershipsRow,
      attendances30Row,
      failedPayments30Row,
      coachUtilizationRow,
    ] = await Promise.all([
      this.prisma.subscription.groupBy({
        by: ['status'],
        where: { studioId },
        _count: { _all: true },
      }),

      this.prisma.subscription.findMany({
        where: {
          studioId,
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
        },
        select: {
          membershipPlan: { select: { priceCents: true, billingInterval: true } },
        },
      }),

      this.prisma.studioMembership.count({
        where: {
          studioId,
          deletedAt: null,
          role: Role.MEMBER,
          user: { deletedAt: null },
        },
      }),

      this.prisma.payment.findMany({
        where: {
          studioId,
          status: PaymentStatus.SUCCEEDED,
          createdAt: { gte: thirtyDaysAgo },
        },
        select: {
          stripePaymentIntentId: true,
          stripeInvoiceId: true,
        },
      }),

      this.prisma.$queryRaw<{ d: Date; amount_cents: bigint }[]>`
        SELECT date_trunc('day', created_at) AS d,
               COALESCE(SUM(amount_cents), 0)::bigint AS amount_cents
        FROM payments
        WHERE studio_id = ${studioId}
          AND status = 'SUCCEEDED'
          AND created_at >= ${thirtyDaysAgo}
        GROUP BY 1
        ORDER BY 1
      `,

      this.prisma.$queryRaw<{ total_cents: bigint }[]>`
        SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total_cents
        FROM payments
        WHERE studio_id = ${studioId}
          AND status = 'SUCCEEDED'
          AND created_at >= ${thirtyDaysAgo}
      `,

      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT COUNT(*)::bigint AS c
        FROM (
          SELECT b.user_id
          FROM bookings b
          WHERE b.studio_id = ${studioId}
            AND b.created_at >= ${thirtyDaysAgo}
            AND b.status NOT IN ('CANCELLED')
          GROUP BY b.user_id
          HAVING COUNT(*) >= 2
        ) t
      `,

      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT COUNT(*)::bigint AS c
        FROM subscriptions s
        WHERE s.studio_id = ${studioId}
          AND s.status = 'CANCELED'
          AND s.updated_at >= ${thirtyDaysAgo}
      `,

      this.prisma.subscription.count({
        where: { studioId, status: SubscriptionStatus.CANCELED },
      }),

      this.prisma.$queryRaw<{ bucket: string; member_count: bigint }[]>`
        SELECT v.bucket, COUNT(*)::bigint AS member_count
        FROM (
          SELECT b.user_id,
                 CASE
                   WHEN COUNT(*) >= 2 THEN '2+'
                   WHEN COUNT(*) = 1 THEN '1'
                   ELSE '0'
                 END AS bucket
          FROM bookings b
          INNER JOIN studio_memberships sm
            ON sm.user_id = b.user_id
           AND sm.studio_id = b.studio_id
           AND sm.deleted_at IS NULL
           AND sm.role = 'MEMBER'
          WHERE b.studio_id = ${studioId}
            AND b.created_at >= ${thirtyDaysAgo}
            AND b.status NOT IN ('CANCELLED')
          GROUP BY b.user_id
        ) v
        GROUP BY v.bucket
      `,

      this.prisma.$queryRaw<{ plan_id: string; plan_name: string; revenue_cents: bigint }[]>`
        WITH pay AS (
          SELECT user_id, SUM(amount_cents)::bigint AS cents
          FROM payments
          WHERE studio_id = ${studioId}
            AND status = 'SUCCEEDED'
            AND created_at >= ${thirtyDaysAgo}
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
        INNER JOIN sub_pick sp ON sp.user_id = pay.user_id
        INNER JOIN membership_plans mp ON mp.id = sp.membership_plan_id
        WHERE mp.studio_id = ${studioId}
        GROUP BY mp.id, mp.name
        ORDER BY revenue_cents DESC
      `,

      this.prisma.$queryRaw<{ cents: bigint }[]>`
        WITH pay AS (
          SELECT user_id, SUM(amount_cents)::bigint AS cents
          FROM payments
          WHERE studio_id = ${studioId}
            AND status = 'SUCCEEDED'
            AND created_at >= ${thirtyDaysAgo}
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
        SELECT COALESCE(SUM(pay.cents), 0)::bigint AS cents
        FROM pay
        LEFT JOIN sub_pick sp ON sp.user_id = pay.user_id
        WHERE sp.membership_plan_id IS NULL
      `,

      this.prisma.$queryRaw<{ total_cents: bigint }[]>`
        SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total_cents
        FROM payments
        WHERE studio_id = ${studioId}
          AND status = 'SUCCEEDED'
          AND created_at >= ${todayStart}
          AND created_at < ${tomorrowStart}
      `,

      this.prisma.$queryRaw<{ total_cents: bigint }[]>`
        SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total_cents
        FROM payments
        WHERE studio_id = ${studioId}
          AND status = 'SUCCEEDED'
          AND created_at >= ${yesterdayStart}
          AND created_at < ${todayStart}
      `,

      this.prisma.$queryRaw<{ payment_method: string; total_cents: bigint }[]>`
        SELECT payment_method, COALESCE(SUM(amount_cents), 0)::bigint AS total_cents
        FROM payments
        WHERE studio_id = ${studioId}
          AND status = 'SUCCEEDED'
          AND created_at >= ${thirtyDaysAgo}
        GROUP BY payment_method
      `,

      this.prisma.$queryRaw<{ total_cents: bigint }[]>`
        SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total_cents
        FROM payments
        WHERE studio_id = ${studioId}
          AND status = 'PENDING'
      `,

      this.prisma.$queryRaw<{ total_cents: bigint }[]>`
        SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total_cents
        FROM payments
        WHERE studio_id = ${studioId}
          AND status IN ('REFUNDED', 'PARTIALLY_REFUNDED')
          AND created_at >= ${thirtyDaysAgo}
      `,

      this.prisma.$queryRaw<{ total_cents: bigint }[]>`
        SELECT COALESCE(SUM(p.amount_cents), 0)::bigint AS total_cents
        FROM payments p
        INNER JOIN day_passes dp
          ON dp.stripe_payment_intent_id = p.stripe_payment_intent_id
         AND dp.studio_id = p.studio_id
        WHERE p.studio_id = ${studioId}
          AND p.status = 'SUCCEEDED'
          AND p.created_at >= ${thirtyDaysAgo}
      `,

      this.prisma.studioMembership.count({
        where: {
          studioId,
          role: Role.MEMBER,
          deletedAt: null,
          createdAt: { gte: thirtyDaysAgo },
          user: { deletedAt: null },
        },
      }),

      this.prisma.studioMembership.count({
        where: {
          studioId,
          role: Role.MEMBER,
          deletedAt: null,
          createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
          user: { deletedAt: null },
        },
      }),

      this.prisma.subscription.count({
        where: {
          studioId,
          createdAt: { gte: todayStart, lt: tomorrowStart },
        },
      }),

      this.prisma.subscription.count({
        where: {
          studioId,
          createdAt: { gte: thirtyDaysAgo },
        },
      }),

      this.prisma.$queryRaw<{ total_cents: bigint }[]>`
        SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total_cents
        FROM payments
        WHERE studio_id = ${studioId}
          AND status = 'SUCCEEDED'
          AND membership_plan_id IS NOT NULL
          AND created_at >= ${todayStart}
          AND created_at < ${tomorrowStart}
      `,

      this.prisma.memberEnrollment.count({
        where: {
          studioId,
          status: EnrollmentFeeStatus.PAID,
          finalizedAt: { gte: thirtyDaysAgo },
        },
      }),

      this.prisma.memberEnrollment.count({
        where: {
          studioId,
          founderNumber: { not: null },
        },
      }),

      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT COUNT(*)::bigint AS c
        FROM studio_memberships sm
        WHERE sm.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM attendances a
            WHERE a.studio_id = sm.studio_id
              AND a.user_id = sm.user_id
              AND a.checked_in_at >= ${thirtyDaysAgo}
          )
      `,

      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT COUNT(*)::bigint AS c
        FROM studio_memberships sm
        WHERE sm.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM studio_waiver_documents swd
            WHERE swd.studio_id = sm.studio_id
              AND swd.is_active = true
          )
          AND NOT EXISTS (
            SELECT 1
            FROM waiver_acceptances wa
            INNER JOIN studio_waiver_documents swd
              ON swd.id = wa.waiver_document_id
             AND swd.studio_id = wa.studio_id
             AND swd.is_active = true
            WHERE wa.studio_id = sm.studio_id
              AND wa.user_id = sm.user_id
          )
      `,

      this.prisma.subscription.count({
        where: {
          studioId,
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
          currentPeriodEnd: { gte: now, lte: expiringBy },
        },
      }),

      this.prisma.attendance.count({
        where: { studioId, checkedInAt: { gte: thirtyDaysAgo } },
      }),

      this.prisma.payment.count({
        where: {
          studioId,
          status: PaymentStatus.FAILED,
          createdAt: { gte: thirtyDaysAgo },
        },
      }),

      this.prisma.$queryRaw<{ with_coach: bigint; total: bigint }[]>`
        SELECT
          COUNT(*) FILTER (WHERE instructor_id IS NOT NULL) AS with_coach,
          COUNT(*) AS total
        FROM scheduled_classes
        WHERE studio_id = ${studioId}
          AND starts_at >= ${thirtyDaysAgo}
          AND status != 'CANCELLED'
      `,
    ]);

    const statusCounts = Object.fromEntries(
      subscriptionStatusRows.map((r) => [r.status, r._count._all]),
    ) as Partial<Record<SubscriptionStatus, number>>;

    const activeSubscriptions = statusCounts[SubscriptionStatus.ACTIVE] ?? 0;
    const trialingSubscriptions = statusCounts[SubscriptionStatus.TRIALING] ?? 0;
    const pastDueSubscriptions = statusCounts[SubscriptionStatus.PAST_DUE] ?? 0;
    const pausedSubscriptions = statusCounts[SubscriptionStatus.PAUSED] ?? 0;

    let estimatedMrrCents = 0;
    for (const s of mrrSubscriptions) {
      estimatedMrrCents += monthlyEquivalentCents(
        s.membershipPlan.priceCents,
        s.membershipPlan.billingInterval,
      );
    }

    const revenueLast30DaysCents = Number(revenueTotalRow[0]?.total_cents ?? 0n);
    const denomMembers = Math.max(1, memberCount);
    const averageRevenuePerMemberCents = Math.round(revenueLast30DaysCents / denomMembers);
    /** Registered gym members: StudioMembership rows with role MEMBER, not deleted, user not deleted. Not subscription status. */
    const memberCountForArpu = memberCount;

    const membersWithTwoPlusBookingsLast30Days = Number(repeatBookersRow[0]?.c ?? 0n);
    const cancellationsLast30Days = Number(cancellations30Row[0]?.c ?? 0n);
    const canceledSubscriptionsTotal = canceledTotalRow;

    const dateMap = new Map<string, number>();
    for (let d = 0; d < 30; d++) {
      const day = new Date(thirtyDaysAgo.getTime() + d * 24 * 60 * 60 * 1000);
      const key = day.toISOString().split('T')[0]!;
      dateMap.set(key, 0);
    }
    for (const row of revenueTrendRows) {
      const key = new Date(row.d).toISOString().split('T')[0]!;
      if (dateMap.has(key)) {
        dateMap.set(key, Number(row.amount_cents));
      }
    }
    const revenueTrend = [...dateMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, amountCents]) => ({ date, amountCents }));

    const subscriptionStatusBreakdown = (
      [
        SubscriptionStatus.ACTIVE,
        SubscriptionStatus.TRIALING,
        SubscriptionStatus.PAST_DUE,
        SubscriptionStatus.PAUSED,
        SubscriptionStatus.CANCELED,
      ] as const
    ).map((status) => ({
      status,
      count: statusCounts[status] ?? 0,
    }));

    const mixMap = new Map(bookingMixRows.map((r) => [r.bucket, Number(r.member_count)]));
    const membersOneBooking = mixMap.get('1') ?? 0;
    const membersRepeatBookings = mixMap.get('2+') ?? 0;
    const membersWithBookings = membersOneBooking + membersRepeatBookings;
    const repeatBookingRatePercent =
      membersWithBookings > 0
        ? Math.round((membersRepeatBookings / membersWithBookings) * 1000) / 10
        : 0;

    let dataQuality: 'empty' | 'demo' | 'live' | 'mixed' = 'empty';
    if (paymentMeta.length > 0) {
      const demoN = paymentMeta.filter((p) =>
        isDemoStripePayment(p.stripePaymentIntentId, p.stripeInvoiceId),
      ).length;
      if (demoN === paymentMeta.length) dataQuality = 'demo';
      else if (demoN === 0) dataQuality = 'live';
      else dataQuality = 'mixed';
    }

    const revenueByMethod = Object.fromEntries(
      revenueByMethodRows.map((r) => [r.payment_method, Number(r.total_cents)]),
    ) as Partial<Record<PaymentMethod, number>>;

    const grossRevenueTodayCents = Number(revenueTodayRow[0]?.total_cents ?? 0n);
    const grossRevenueYesterdayCents = Number(revenueYesterdayRow[0]?.total_cents ?? 0n);
    const cashRevenueLast30DaysCents = revenueByMethod[PaymentMethod.CASH] ?? 0;
    const stripeRevenueLast30DaysCents =
      (revenueByMethod[PaymentMethod.STRIPE] ?? 0) + (revenueByMethod[PaymentMethod.TERMINAL] ?? 0);
    const pendingRevenueCents = Number(pendingRevenueRow[0]?.total_cents ?? 0n);
    const refundedRevenueCents = Number(refundedRevenueRow[0]?.total_cents ?? 0n);
    const dayPassRevenueLast30DaysCents = Number(dayPassRevenueRow[0]?.total_cents ?? 0n);
    const newMembersLast30Days = newMembers30Row;
    const newMembersPrevious30Days = newMembersPrev30Row;
    const membershipGrowthPercent = pctChange(newMembersLast30Days, newMembersPrevious30Days);
    const estimatedArrCents = estimatedMrrCents * 12;
    const averageMembershipPriceCents =
      mrrSubscriptions.length > 0
        ? Math.round(
            mrrSubscriptions.reduce((sum, s) => sum + s.membershipPlan.priceCents, 0) /
              mrrSubscriptions.length,
          )
        : 0;
    const topSellingPlan =
      revenueByPlanRows.length > 0
        ? {
            planId: revenueByPlanRows[0]!.plan_id,
            planName: revenueByPlanRows[0]!.plan_name,
            revenueCents: Number(revenueByPlanRows[0]!.revenue_cents),
          }
        : null;
    const coachUtilRow = coachUtilizationRow[0];
    const coachUtilizationPercent =
      coachUtilRow && Number(coachUtilRow.total) > 0
        ? Math.round((Number(coachUtilRow.with_coach) / Number(coachUtilRow.total)) * 1000) / 10
        : 0;
    const attendancesLast30Days = attendances30Row;
    const averageVisitsPerMember30d =
      memberCount > 0 ? Math.round((attendancesLast30Days / memberCount) * 10) / 10 : 0;

    return {
      period: {
        days: 30,
        from: thirtyDaysAgo.toISOString(),
        to: now.toISOString(),
      },
      dataQuality,
      estimatedMrrCents,
      activeSubscriptions,
      trialingSubscriptions,
      pastDueSubscriptions,
      pausedSubscriptions,
      canceledSubscriptionsTotal,
      cancellationsLast30Days,
      revenueLast30DaysCents,
      averageRevenuePerMemberCents,
      memberCountForArpu,
      membersWithTwoPlusBookingsLast30Days,
      repeatBookingRatePercent,
      bookingFrequencyBuckets: [
        { label: '1 booking', memberCount: membersOneBooking },
        { label: '2+ bookings', memberCount: membersRepeatBookings },
      ],
      revenueTrend,
      subscriptionStatusBreakdown,
      revenueByPlan: revenueByPlanRows.map((r) => ({
        planId: r.plan_id,
        planName: r.plan_name,
        revenueCents: Number(r.revenue_cents),
      })),
      unattributedRevenueCents: Number(unattributedRow[0]?.cents ?? 0n),
      grossRevenueTodayCents,
      grossRevenueYesterdayCents,
      revenueTodayVsYesterdayPercent: pctChange(
        grossRevenueTodayCents,
        grossRevenueYesterdayCents,
      ),
      cashRevenueLast30DaysCents,
      stripeRevenueLast30DaysCents,
      pendingRevenueCents,
      refundedRevenueCents,
      dayPassRevenueLast30DaysCents,
      newMembersLast30Days,
      newMembersPrevious30Days,
      membershipGrowthPercent,
      estimatedArrCents,
      averageMembershipPriceCents,
      newSubscriptionsToday: newSubscriptionsTodayRow,
      newSubscriptionsLast30Days: newSubscriptions30Row,
      membershipSalesRevenueTodayCents: Number(membershipSalesTodayRow[0]?.total_cents ?? 0n),
      enrollmentFeesPaidCount30d: enrollmentPaid30Row,
      foundersEnrolledCount: foundersCountRow,
      topSellingPlan,
      membersInactive30PlusDays: Number(inactiveMembersRow[0]?.c ?? 0n),
      waiversPendingCount: Number(waiversPendingRow[0]?.c ?? 0n),
      expiringMembershipsNext30Days: expiringMembershipsRow,
      averageVisitsPerMember30d,
      failedPaymentsLast30Days: failedPayments30Row,
      coachUtilizationPercent,
      generatedAt: now.toISOString(),
    };
  }
}
