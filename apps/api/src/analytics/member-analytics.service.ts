import { Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { getStudioLocalDateKey, studioLocalCalendarDaysBetween } from '../common/date/studio-local-date';
import { PrismaService } from '../prisma/prisma.service';
import { currentlyEntitledSubscriptionWhere } from '../memberships/membership-entitlement';
import { SQL_ATTENDANCE_EXCLUDE } from './analytics-exclusion.utils';
import { assertStudioTimezone } from './analytics-timezone.utils';
import {
  classifyMemberEngagement,
  computeVisitsPerWeek,
  frequencyBucket,
  isRequiresAttentionCandidate,
  MEMBER_ENGAGEMENT_STATUS_LABELS,
} from './member-engagement.utils';
import { computeConsecutiveActiveWeekStreak } from './member-analytics-schedule.utils';
import {
  memberAnalyticsPeriodWindows,
  MEMBER_ANALYTICS_PERIOD_LABELS,
  rollingWindowStart,
  type MemberAnalyticsPeriodKey,
} from './member-analytics-range.utils';
import type {
  MemberAnalyticsActivityDto,
  MemberAnalyticsDetailDto,
  MemberAnalyticsListDto,
  MemberAnalyticsRowDto,
  MemberAnalyticsSummaryDto,
} from './member-analytics.types';

type RawMemberStats = {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  joined_at: Date;
  plan_name: string | null;
  is_entitled: boolean;
  visits_period: bigint;
  visits_30d: bigint;
  visits_90d: bigint;
  visits_prior_30d: bigint;
  last_visit_at: Date | null;
  first_visit_at: Date | null;
  favorite_class: string | null;
  favorite_time: string | null;
  favorite_instructor: string | null;
  favorite_weekday: number | null;
  active_weeks_90d: bigint;
  consecutive_week_streak: number;
  week_start_keys: string[];
  bookings_period: bigint;
  attended_bookings_period: bigint;
  walk_ins_period: bigint;
  no_shows_period: bigint;
};

/**
 * Attendance analytics preserve physical check-ins even when ScheduledClass.status
 * is later CANCELLED — the member did attend; cancellation does not invalidate Attendance.
 * Period inclusion uses Attendance.checkedInAt; schedule preferences use ScheduledClass.startsAt.
 */
@Injectable()
export class MemberAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getStudioTimezone(studioId: string): Promise<string> {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { timezone: true },
    });
    if (!studio) throw new NotFoundException('Studio not found');
    return assertStudioTimezone(studio.timezone);
  }

  private resolvePeriod(
    timezone: string,
    period?: string,
    from?: string,
    to?: string,
    now = new Date(),
  ) {
    const key = (['this_month', 'prev_month', 'last_30d', 'last_90d', 'this_year', 'custom'] as const).includes(
      period as MemberAnalyticsPeriodKey,
    )
      ? (period as MemberAnalyticsPeriodKey)
      : 'this_month';
    return memberAnalyticsPeriodWindows(now, timezone, key, from, to);
  }

  async getSummary(
    studioId: string,
    period?: string,
    from?: string,
    to?: string,
  ): Promise<MemberAnalyticsSummaryDto> {
    const timezone = await this.getStudioTimezone(studioId);
    const now = new Date();
    const windows = this.resolvePeriod(timezone, period, from, to, now);
    const fourteenAgo = rollingWindowStart(now, timezone, 14);

    const entitledWhere = currentlyEntitledSubscriptionWhere(now);

    const [
      activeMembers,
      periodStats,
      prevPeriodStats,
      inactive14Plus,
      newMembers,
    ] = await Promise.all([
      this.prisma.studioMembership.count({
        where: {
          studioId,
          role: Role.MEMBER,
          excludeFromAnalytics: false,
          deletedAt: null,
          user: {
            deletedAt: null,
            subscriptions: { some: { studioId, ...entitledWhere } },
          },
        },
      }),
      this.prisma.$queryRaw<{ members_attended: bigint; attendances: bigint }[]>`
        SELECT
          COUNT(DISTINCT a.user_id) AS members_attended,
          COUNT(*) AS attendances
        FROM attendances a
        JOIN studio_memberships sm ON sm.studio_id = a.studio_id AND sm.user_id = a.user_id
        WHERE a.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.exclude_from_analytics = false
          AND sm.deleted_at IS NULL
          AND a.checked_in_at >= ${windows.periodStart}
          AND a.checked_in_at <= ${windows.periodEnd}
          ${SQL_ATTENDANCE_EXCLUDE}
      `,
      this.prisma.$queryRaw<{ attendances: bigint }[]>`
        SELECT COUNT(*) AS attendances
        FROM attendances a
        JOIN studio_memberships sm ON sm.studio_id = a.studio_id AND sm.user_id = a.user_id
        WHERE a.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.exclude_from_analytics = false
          AND sm.deleted_at IS NULL
          AND a.checked_in_at >= ${windows.prevPeriodStart}
          AND a.checked_in_at <= ${windows.prevPeriodEnd}
          ${SQL_ATTENDANCE_EXCLUDE}
      `,
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT COUNT(*) AS c
        FROM studio_memberships sm
        WHERE sm.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.exclude_from_analytics = false
          AND sm.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.studio_id = sm.studio_id AND s.user_id = sm.user_id
              AND s.status IN ('ACTIVE','TRIALING')
              AND (s.entitlement_ends_at IS NULL AND s.current_period_end > ${now}
                   OR s.entitlement_ends_at > ${now})
          )
          AND NOT EXISTS (
            SELECT 1 FROM attendances a
            WHERE a.studio_id = sm.studio_id AND a.user_id = sm.user_id
              AND a.checked_in_at >= ${fourteenAgo}
              ${SQL_ATTENDANCE_EXCLUDE}
          )
      `,
      this.prisma.studioMembership.count({
        where: {
          studioId,
          role: Role.MEMBER,
          excludeFromAnalytics: false,
          deletedAt: null,
          createdAt: { gte: windows.periodStart, lte: windows.periodEnd },
        },
      }),
    ]);

    const membersAttended = Number(periodStats[0]?.members_attended ?? 0n);
    const attendances = Number(periodStats[0]?.attendances ?? 0n);
    const prevAttendances = Number(prevPeriodStats[0]?.attendances ?? 0n);

    const periodDays = Math.max(
      1,
      Math.ceil((windows.periodEnd.getTime() - windows.periodStart.getTime()) / 86_400_000) + 1,
    );

    let engagementTrendPct: number | null = null;
    if (prevAttendances > 0) {
      engagementTrendPct = Math.round(((attendances - prevAttendances) / prevAttendances) * 100);
    }

    return {
      period: windows.period,
      periodLabel: MEMBER_ANALYTICS_PERIOD_LABELS[windows.period],
      timezone,
      periodStart: windows.periodStart.toISOString(),
      periodEnd: windows.periodEnd.toISOString(),
      isPartialPeriod: windows.isPartialPeriod,
      kpis: {
        activeMembers,
        membersAttended,
        attendances,
        visitsPerAttendingMember:
          membersAttended > 0 ? Math.round((attendances / membersAttended) * 10) / 10 : null,
        visitsPerActiveMember:
          activeMembers > 0 ? Math.round((attendances / activeMembers) * 10) / 10 : null,
        weeklyFrequencyPerAttendingMember:
          membersAttended > 0
            ? computeVisitsPerWeek(attendances / membersAttended, periodDays)
            : null,
        inactive14PlusDays: Number(inactive14Plus[0]?.c ?? 0n),
        newMembers,
        engagementTrendPct,
      },
    };
  }

  private async loadMemberStats(
    studioId: string,
    timezone: string,
    periodStart: Date,
    periodEnd: Date,
    now: Date,
  ): Promise<RawMemberStats[]> {
    const thirtyStart = rollingWindowStart(now, timezone, 30);
    const sixtyStart = rollingWindowStart(now, timezone, 60);
    const ninetyStart = rollingWindowStart(now, timezone, 90);

    return this.prisma.$queryRaw<RawMemberStats[]>`
      WITH member_base AS (
        SELECT
          sm.user_id,
          u.first_name,
          u.last_name,
          u.email,
          sm.created_at AS joined_at,
          mp.name AS plan_name,
          EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.studio_id = sm.studio_id AND s.user_id = sm.user_id
              AND (
                (s.status IN ('ACTIVE','TRIALING') AND s.entitlement_ends_at IS NULL AND s.current_period_end > ${now})
                OR (s.status IN ('ACTIVE','TRIALING','CANCELED') AND s.entitlement_ends_at > ${now})
              )
              AND (s.current_period_start IS NULL OR s.current_period_start <= ${now})
          ) AS is_entitled
        FROM studio_memberships sm
        JOIN users u ON u.id = sm.user_id
        LEFT JOIN LATERAL (
          SELECT mp2.name
          FROM subscriptions s2
          JOIN membership_plans mp2 ON mp2.id = s2.membership_plan_id
          WHERE s2.studio_id = sm.studio_id AND s2.user_id = sm.user_id
            AND (
              (s2.status IN ('ACTIVE','TRIALING') AND s2.entitlement_ends_at IS NULL AND s2.current_period_end > ${now})
              OR (s2.status IN ('ACTIVE','TRIALING','CANCELED') AND s2.entitlement_ends_at > ${now})
            )
            AND (s2.current_period_start IS NULL OR s2.current_period_start <= ${now})
          ORDER BY s2.created_at DESC
          LIMIT 1
        ) mp ON true
        WHERE sm.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.exclude_from_analytics = false
          AND sm.deleted_at IS NULL
          AND u.deleted_at IS NULL
      ),
      attendance_agg AS (
        SELECT
          a.user_id,
          COUNT(*) FILTER (WHERE a.checked_in_at >= ${periodStart} AND a.checked_in_at <= ${periodEnd}) AS visits_period,
          COUNT(*) FILTER (WHERE a.checked_in_at >= ${thirtyStart}) AS visits_30d,
          COUNT(*) FILTER (WHERE a.checked_in_at >= ${sixtyStart} AND a.checked_in_at < ${thirtyStart}) AS visits_prior_30d,
          COUNT(*) FILTER (WHERE a.checked_in_at >= ${ninetyStart}) AS visits_90d,
          MAX(a.checked_in_at) AS last_visit_at,
          MIN(a.checked_in_at) AS first_visit_at,
          COUNT(DISTINCT to_char(a.checked_in_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}, 'IYYY-IW')) FILTER (
            WHERE a.checked_in_at >= ${ninetyStart}
          ) AS active_weeks_90d
        FROM attendances a
        JOIN member_base mb ON mb.user_id = a.user_id
        WHERE a.studio_id = ${studioId}
          ${SQL_ATTENDANCE_EXCLUDE}
        GROUP BY a.user_id
      ),
      booking_agg AS (
        SELECT
          b.user_id,
          COUNT(*) FILTER (WHERE b.created_at >= ${periodStart} AND b.created_at <= ${periodEnd} AND b.status != 'CANCELLED') AS bookings_period,
          COUNT(*) FILTER (
            WHERE b.status = 'NO_SHOW' AND sc.starts_at >= ${periodStart} AND sc.starts_at <= ${periodEnd}
          ) AS no_shows_period
        FROM bookings b
        JOIN member_base mb ON mb.user_id = b.user_id
        JOIN scheduled_classes sc ON sc.id = b.scheduled_class_id
        WHERE b.studio_id = ${studioId}
        GROUP BY b.user_id
      ),
      attended_bookings AS (
        SELECT a.user_id, COUNT(*) AS attended_bookings_period
        FROM attendances a
        JOIN member_base mb ON mb.user_id = a.user_id
        JOIN bookings b ON b.scheduled_class_id = a.scheduled_class_id AND b.user_id = a.user_id AND b.status = 'CONFIRMED'
        WHERE a.studio_id = ${studioId}
          AND a.checked_in_at >= ${periodStart}
          AND a.checked_in_at <= ${periodEnd}
          ${SQL_ATTENDANCE_EXCLUDE}
        GROUP BY a.user_id
      )
      SELECT
        mb.user_id,
        mb.first_name,
        mb.last_name,
        mb.email,
        mb.joined_at,
        mb.plan_name,
        mb.is_entitled,
        COALESCE(aa.visits_period, 0) AS visits_period,
        COALESCE(aa.visits_30d, 0) AS visits_30d,
        COALESCE(aa.visits_90d, 0) AS visits_90d,
        COALESCE(aa.visits_prior_30d, 0) AS visits_prior_30d,
        aa.last_visit_at,
        aa.first_visit_at,
        NULL::text AS favorite_class,
        NULL::text AS favorite_time,
        NULL::text AS favorite_instructor,
        NULL::int AS favorite_weekday,
        COALESCE(aa.active_weeks_90d, 0) AS active_weeks_90d,
        0 AS consecutive_week_streak,
        ARRAY[]::text[] AS week_start_keys,
        COALESCE(ba.bookings_period, 0) AS bookings_period,
        COALESCE(ab.attended_bookings_period, 0) AS attended_bookings_period,
        GREATEST(COALESCE(aa.visits_period, 0) - COALESCE(ab.attended_bookings_period, 0), 0) AS walk_ins_period,
        COALESCE(ba.no_shows_period, 0) AS no_shows_period
      FROM member_base mb
      LEFT JOIN attendance_agg aa ON aa.user_id = mb.user_id
      LEFT JOIN booking_agg ba ON ba.user_id = mb.user_id
      LEFT JOIN attended_bookings ab ON ab.user_id = mb.user_id
    `;
  }

  private async loadMemberFavorites(
    studioId: string,
    timezone: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<
    Map<
      string,
      {
        favoriteClass: string | null;
        favoriteTime: string | null;
        favoriteInstructor: string | null;
        favoriteWeekday: number | null;
      }
    >
  > {
    // Class-demand preferences use ScheduledClass.startsAt (studio-local), not check-in time.
    const rows = await this.prisma.$queryRaw<
      Array<{
        user_id: string;
        class_name: string;
        schedule_time: string;
        weekday: number;
        instructor_name: string | null;
      }>
    >`
      SELECT
        a.user_id,
        ct.name AS class_name,
        to_char(sc.starts_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}, 'HH24:MI') AS schedule_time,
        EXTRACT(DOW FROM (sc.starts_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}))::int AS weekday,
        NULLIF(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS instructor_name
      FROM attendances a
      JOIN studio_memberships sm ON sm.studio_id = a.studio_id AND sm.user_id = a.user_id
      JOIN scheduled_classes sc ON sc.id = a.scheduled_class_id
      JOIN class_templates ct ON ct.id = sc.class_template_id
      LEFT JOIN users u ON u.id = sc.instructor_id
      WHERE a.studio_id = ${studioId}
        AND sm.role = 'MEMBER'
        AND sm.exclude_from_analytics = false
        AND sm.deleted_at IS NULL
        AND a.checked_in_at >= ${periodStart}
        AND a.checked_in_at <= ${periodEnd}
        ${SQL_ATTENDANCE_EXCLUDE}
    `;

    type Counter = Map<string, { cnt: number; tieBreak: string }>;
    const classCounters = new Map<string, Counter>();
    const timeCounters = new Map<string, Counter>();
    const weekdayCounters = new Map<string, Counter>();
    const instructorCounters = new Map<string, Counter>();

    const bump = (map: Map<string, Counter>, userId: string, key: string, tieBreak: string) => {
      const userMap = map.get(userId) ?? new Map<string, { cnt: number; tieBreak: string }>();
      const prev = userMap.get(key);
      userMap.set(key, { cnt: (prev?.cnt ?? 0) + 1, tieBreak });
      map.set(userId, userMap);
    };

    for (const row of rows) {
      bump(classCounters, row.user_id, row.class_name, row.class_name);
      bump(timeCounters, row.user_id, row.schedule_time, row.schedule_time);
      bump(weekdayCounters, row.user_id, String(row.weekday), String(row.weekday));
      if (row.instructor_name) {
        bump(instructorCounters, row.user_id, row.instructor_name, row.instructor_name);
      }
    }

    const pickTop = (counter: Counter | undefined): string | null => {
      if (!counter) return null;
      let best: { key: string; cnt: number; tieBreak: string } | null = null;
      for (const [key, value] of counter.entries()) {
        if (!best || value.cnt > best.cnt || (value.cnt === best.cnt && value.tieBreak < best.tieBreak)) {
          best = { key, ...value };
        }
      }
      return best?.key ?? null;
    };

    const userIds = new Set([
      ...classCounters.keys(),
      ...timeCounters.keys(),
      ...weekdayCounters.keys(),
      ...instructorCounters.keys(),
    ]);

    const byUser = new Map<
      string,
      {
        favoriteClass: string | null;
        favoriteTime: string | null;
        favoriteInstructor: string | null;
        favoriteWeekday: number | null;
      }
    >();

    for (const userId of userIds) {
      const weekdayRaw = pickTop(weekdayCounters.get(userId));
      byUser.set(userId, {
        favoriteClass: pickTop(classCounters.get(userId)),
        favoriteTime: pickTop(timeCounters.get(userId)),
        favoriteInstructor: pickTop(instructorCounters.get(userId)),
        favoriteWeekday: weekdayRaw != null ? Number(weekdayRaw) : null,
      });
    }

    return byUser;
  }

  /** Attendance-event weeks (checkedInAt) for consecutive streak — not class schedule time. */
  private async loadMemberActiveWeeks(
    studioId: string,
    timezone: string,
    now: Date,
  ): Promise<Map<string, string[]>> {
    const ninetyStart = rollingWindowStart(now, timezone, 90);
    const rows = await this.prisma.$queryRaw<Array<{ user_id: string; week_start: Date }>>`
      SELECT DISTINCT
        a.user_id,
        date_trunc(
          'week',
          (a.checked_in_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone})::timestamp
        )::date AS week_start
      FROM attendances a
      JOIN studio_memberships sm ON sm.studio_id = a.studio_id AND sm.user_id = a.user_id
      WHERE a.studio_id = ${studioId}
        AND sm.role = 'MEMBER'
        AND sm.exclude_from_analytics = false
        AND a.checked_in_at >= ${ninetyStart}
        ${SQL_ATTENDANCE_EXCLUDE}
    `;

    const byUser = new Map<string, string[]>();
    for (const row of rows) {
      const key = row.week_start.toISOString().slice(0, 10);
      const list = byUser.get(row.user_id) ?? [];
      list.push(key);
      byUser.set(row.user_id, list);
    }
    for (const [userId, keys] of byUser.entries()) {
      byUser.set(userId, [...new Set(keys)].sort((a, b) => b.localeCompare(a)));
    }
    return byUser;
  }

  private async loadMemberStatsWithFavorites(
    studioId: string,
    timezone: string,
    periodStart: Date,
    periodEnd: Date,
    now: Date,
  ): Promise<RawMemberStats[]> {
    const [rows, favorites, activeWeeks] = await Promise.all([
      this.loadMemberStats(studioId, timezone, periodStart, periodEnd, now),
      this.loadMemberFavorites(studioId, timezone, periodStart, periodEnd),
      this.loadMemberActiveWeeks(studioId, timezone, now),
    ]);
    return rows.map((row) => {
      const fav = favorites.get(row.user_id);
      const weekKeys = activeWeeks.get(row.user_id) ?? [];
      return {
        ...row,
        favorite_class: fav?.favoriteClass ?? null,
        favorite_time: fav?.favoriteTime ?? null,
        favorite_instructor: fav?.favoriteInstructor ?? null,
        favorite_weekday: fav?.favoriteWeekday ?? null,
        week_start_keys: weekKeys,
        consecutive_week_streak: computeConsecutiveActiveWeekStreak(weekKeys, now, timezone),
      };
    });
  }

  private mapRow(
    raw: RawMemberStats,
    periodDays: number,
    now: Date,
    timezone: string,
  ): MemberAnalyticsRowDto {
    const daysSinceLastVisit = raw.last_visit_at
      ? Math.max(0, studioLocalCalendarDaysBetween(raw.last_visit_at, now, timezone))
      : null;
    const engagement = classifyMemberEngagement({
      visitsLast30d: Number(raw.visits_30d),
      visitsPrior30d: Number(raw.visits_prior_30d),
      daysSinceLastVisit,
      activeWeeksLast90d: Number(raw.active_weeks_90d),
      isEntitled: raw.is_entitled,
    });

    return {
      userId: raw.user_id,
      firstName: raw.first_name,
      lastName: raw.last_name,
      email: raw.email,
      planName: raw.plan_name,
      visitsPeriod: Number(raw.visits_period),
      visits30d: Number(raw.visits_30d),
      visits90d: Number(raw.visits_90d),
      visitsPerWeek: computeVisitsPerWeek(Number(raw.visits_30d), 30),
      lastVisitAt: raw.last_visit_at?.toISOString() ?? null,
      favoriteClass: raw.favorite_class,
      favoriteTime: raw.favorite_time,
      consecutiveWeekStreak: raw.consecutive_week_streak,
      activeWeeks90d: Number(raw.active_weeks_90d),
      trendPct: engagement.trendPct,
      engagementStatus: engagement.status,
      engagementReasons: engagement.reasons,
    };
  }

  private buildFrequencyDistribution(
    rows: Array<{ visitsPeriod: number; isEntitled: boolean }>,
    population: 'active' | 'all',
  ) {
    const source = population === 'active' ? rows.filter((r) => r.isEntitled) : rows;
    const freqMap = new Map<string, number>();
    for (const row of source) {
      const bucket = frequencyBucket(row.visitsPeriod);
      freqMap.set(bucket, (freqMap.get(bucket) ?? 0) + 1);
    }
    return ['0', '1-3', '4-7', '8-11', '12-15', '16+'].map((bucket) => ({
      bucket,
      memberCount: freqMap.get(bucket) ?? 0,
    }));
  }

  async listMembers(
    studioId: string,
    query: {
      period?: string;
      from?: string;
      to?: string;
      search?: string;
      sort?: string;
      order?: 'asc' | 'desc';
      page?: number;
      limit?: number;
      planId?: string;
      status?: string;
    },
  ): Promise<MemberAnalyticsListDto> {
    const timezone = await this.getStudioTimezone(studioId);
    const now = new Date();
    const windows = this.resolvePeriod(timezone, query.period, query.from, query.to, now);
    const periodDays = Math.max(
      1,
      Math.ceil((windows.periodEnd.getTime() - windows.periodStart.getTime()) / 86_400_000) + 1,
    );

    let rows = await this.loadMemberStatsWithFavorites(studioId, timezone, windows.periodStart, windows.periodEnd, now);

    if (query.search) {
      const q = query.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.first_name.toLowerCase().includes(q) ||
          r.last_name.toLowerCase().includes(q) ||
          (r.email?.toLowerCase().includes(q) ?? false),
      );
    }

    if (query.status) {
      rows = rows.filter((r) => {
        const mapped = this.mapRow(r, periodDays, now, timezone);
        return mapped.engagementStatus === query.status;
      });
    }

    const sort = query.sort ?? 'visitsPeriod';
    const order = query.order ?? 'desc';
    const mapped = rows.map((r) => this.mapRow(r, periodDays, now, timezone));
    mapped.sort((a, b) => {
      const av = (a as Record<string, unknown>)[sort];
      const bv = (b as Record<string, unknown>)[sort];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return order === 'asc' ? av - bv : bv - av;
      }
      return order === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 25));
    const total = mapped.length;
    const data = mapped.slice((page - 1) * limit, page * limit);

    return { data, total, page, limit };
  }

  async getMemberDetail(
    studioId: string,
    userId: string,
    period?: string,
    from?: string,
    to?: string,
  ): Promise<MemberAnalyticsDetailDto> {
    const timezone = await this.getStudioTimezone(studioId);
    const now = new Date();
    const windows = this.resolvePeriod(timezone, period, from, to, now);
    const periodDays = Math.max(
      1,
      Math.ceil((windows.periodEnd.getTime() - windows.periodStart.getTime()) / 86_400_000) + 1,
    );

    const rows = await this.loadMemberStatsWithFavorites(studioId, timezone, windows.periodStart, windows.periodEnd, now);
    const raw = rows.find((r) => r.user_id === userId);
    if (!raw) throw new NotFoundException('Member not found');

    const base = this.mapRow(raw, periodDays, now, timezone);
    const attended = Number(raw.attended_bookings_period);
    const noShows = Number(raw.no_shows_period);
    const attendanceRatePct =
      attended + noShows > 0 ? Math.round((attended / (attended + noShows)) * 100) : null;

    const monthlyTrend = await this.loadMemberMonthlyTrend(studioId, userId, timezone, now);

    return {
      ...base,
      joinedAt: raw.joined_at.toISOString(),
      isEntitled: raw.is_entitled,
      visitsPrior30d: Number(raw.visits_prior_30d),
      firstVisitAt: raw.first_visit_at?.toISOString() ?? null,
      favoriteInstructor: raw.favorite_instructor,
      favoriteWeekday: raw.favorite_weekday,
      bookingsPeriod: Number(raw.bookings_period),
      attendedBookingsPeriod: attended,
      walkInsPeriod: Number(raw.walk_ins_period),
      attendanceRatePct,
      noShowsPeriod: noShows,
      monthlyTrend,
    };
  }

  private async loadMemberMonthlyTrend(
    studioId: string,
    userId: string,
    timezone: string,
    now: Date,
  ) {
    const rows = await this.prisma.$queryRaw<{ month_key: string; attendances: bigint }[]>`
      SELECT
        to_char(a.checked_in_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}, 'YYYY-MM') AS month_key,
        COUNT(*) AS attendances
      FROM attendances a
      WHERE a.studio_id = ${studioId}
        AND a.user_id = ${userId}
        AND a.checked_in_at >= ${new Date(now.getTime() - 365 * 86_400_000)}
        ${SQL_ATTENDANCE_EXCLUDE}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    const currentMonth = getStudioLocalDateKey(now, timezone).slice(0, 7);
    return rows.map((r) => ({
      month: r.month_key,
      attendances: Number(r.attendances),
      isPartial: r.month_key === currentMonth,
    }));
  }

  async getActivity(
    studioId: string,
    period?: string,
    from?: string,
    to?: string,
    frequencyPopulation: 'active' | 'all' = 'active',
  ): Promise<MemberAnalyticsActivityDto> {
    const timezone = await this.getStudioTimezone(studioId);
    const now = new Date();
    const windows = this.resolvePeriod(timezone, period, from, to, now);
    const periodDays = Math.max(
      1,
      Math.ceil((windows.periodEnd.getTime() - windows.periodStart.getTime()) / 86_400_000) + 1,
    );

    const rows = await this.loadMemberStatsWithFavorites(studioId, timezone, windows.periodStart, windows.periodEnd, now);
    const mapped = rows.map((r) => this.mapRow(r, periodDays, now, timezone));

    const topActive = [...mapped]
      .sort((a, b) => b.visitsPeriod - a.visitsPeriod || a.lastName.localeCompare(b.lastName))
      .slice(0, 10);

    const requiresAttention = rows
      .map((raw) => this.mapRow(raw, periodDays, now, timezone))
      .filter((m, idx) => {
        const raw = rows[idx]!;
        const engagement = classifyMemberEngagement({
          visitsLast30d: Number(raw.visits_30d),
          visitsPrior30d: Number(raw.visits_prior_30d),
          daysSinceLastVisit: raw.last_visit_at
            ? Math.max(0, studioLocalCalendarDaysBetween(raw.last_visit_at, now, timezone))
            : null,
          activeWeeksLast90d: Number(raw.active_weeks_90d),
          isEntitled: raw.is_entitled,
        });
        return isRequiresAttentionCandidate(engagement, raw.is_entitled);
      })
      .map((m) => ({
        ...m,
        attentionReasons: m.engagementReasons.length > 0 ? m.engagementReasons : [MEMBER_ENGAGEMENT_STATUS_LABELS[m.engagementStatus]],
      }))
      .sort((a, b) => {
        const aDays = a.lastVisitAt ? new Date(a.lastVisitAt).getTime() : 0;
        const bDays = b.lastVisitAt ? new Date(b.lastVisitAt).getTime() : 0;
        return aDays - bDays;
      })
      .slice(0, 10);

    const frequencySource = mapped.map((m, idx) => ({
      visitsPeriod: m.visitsPeriod,
      isEntitled: rows[idx]!.is_entitled,
    }));
    const frequencyDistribution = this.buildFrequencyDistribution(frequencySource, frequencyPopulation);

    const classPreferences = await this.loadClassPreferences(studioId, windows.periodStart, windows.periodEnd);
    const dayTimeHeatmap = await this.loadHeatmap(studioId, timezone, windows.periodStart, windows.periodEnd);
    const monthlyTrend = await this.loadStudioMonthlyTrend(studioId, timezone, now);
    const planUtilization = await this.loadPlanUtilization(studioId, windows.periodStart, windows.periodEnd, now);

    return {
      topActive,
      requiresAttention,
      frequencyDistribution,
      frequencyPopulation,
      classPreferences,
      dayTimeHeatmap,
      monthlyTrend,
      planUtilization,
    };
  }

  private async loadClassPreferences(studioId: string, periodStart: Date, periodEnd: Date) {
    const rows = await this.prisma.$queryRaw<
      { class_template_id: string; class_name: string; unique_members: bigint; attendances: bigint }[]
    >`
      SELECT
        ct.id AS class_template_id,
        ct.name AS class_name,
        COUNT(DISTINCT a.user_id) AS unique_members,
        COUNT(*) AS attendances
      FROM attendances a
      JOIN studio_memberships sm ON sm.studio_id = a.studio_id AND sm.user_id = a.user_id
      JOIN scheduled_classes sc ON sc.id = a.scheduled_class_id
      JOIN class_templates ct ON ct.id = sc.class_template_id
      WHERE a.studio_id = ${studioId}
        AND sm.role = 'MEMBER'
        AND sm.exclude_from_analytics = false
        AND a.checked_in_at >= ${periodStart}
        AND a.checked_in_at <= ${periodEnd}
        ${SQL_ATTENDANCE_EXCLUDE}
      GROUP BY ct.id, ct.name
      ORDER BY attendances DESC
    `;
    const total = rows.reduce((s, r) => s + Number(r.attendances), 0);
    return rows.map((r) => {
      const attendances = Number(r.attendances);
      const uniqueMembers = Number(r.unique_members);
      return {
        classTemplateId: r.class_template_id,
        className: r.class_name,
        uniqueMembers,
        attendances,
        visitsPerMember: uniqueMembers > 0 ? Math.round((attendances / uniqueMembers) * 10) / 10 : 0,
        attendanceSharePct: total > 0 ? Math.round((attendances / total) * 1000) / 10 : 0,
      };
    });
  }

  private async loadHeatmap(
    studioId: string,
    timezone: string,
    periodStart: Date,
    periodEnd: Date,
  ) {
    const rows = await this.prisma.$queryRaw<
      { weekday: number; time_bucket: string; attendances: bigint; unique_members: bigint }[]
    >`
      SELECT
        EXTRACT(DOW FROM (sc.starts_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}))::int AS weekday,
        to_char(sc.starts_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}, 'HH24:MI') AS time_bucket,
        COUNT(*) AS attendances,
        COUNT(DISTINCT a.user_id) AS unique_members
      FROM attendances a
      JOIN studio_memberships sm ON sm.studio_id = a.studio_id AND sm.user_id = a.user_id
      JOIN scheduled_classes sc ON sc.id = a.scheduled_class_id
      WHERE a.studio_id = ${studioId}
        AND sm.role = 'MEMBER'
        AND sm.exclude_from_analytics = false
        AND a.checked_in_at >= ${periodStart}
        AND a.checked_in_at <= ${periodEnd}
        ${SQL_ATTENDANCE_EXCLUDE}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;
    return rows.map((r) => ({
      weekday: r.weekday,
      timeBucket: r.time_bucket,
      attendances: Number(r.attendances),
      uniqueMembers: Number(r.unique_members),
    }));
  }

  private async loadStudioMonthlyTrend(studioId: string, timezone: string, now: Date) {
    const rows = await this.prisma.$queryRaw<
      { month_key: string; attendances: bigint; unique_members: bigint }[]
    >`
      SELECT
        to_char(a.checked_in_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}, 'YYYY-MM') AS month_key,
        COUNT(*) AS attendances,
        COUNT(DISTINCT a.user_id) AS unique_members
      FROM attendances a
      JOIN studio_memberships sm ON sm.studio_id = a.studio_id AND sm.user_id = a.user_id
      WHERE a.studio_id = ${studioId}
        AND sm.role = 'MEMBER'
        AND sm.exclude_from_analytics = false
        AND a.checked_in_at >= ${new Date(now.getTime() - 365 * 86_400_000)}
        ${SQL_ATTENDANCE_EXCLUDE}
      GROUP BY 1
      ORDER BY 1 ASC
    `;
    const currentMonth = getStudioLocalDateKey(now, timezone).slice(0, 7);
    return rows.map((r) => {
      const attendances = Number(r.attendances);
      const uniqueMembers = Number(r.unique_members);
      return {
        month: r.month_key,
        attendances,
        uniqueMembers,
        visitsPerMember:
          uniqueMembers > 0 ? Math.round((attendances / uniqueMembers) * 10) / 10 : null,
        isPartial: r.month_key === currentMonth,
      };
    });
  }

  private async loadPlanUtilization(
    studioId: string,
    periodStart: Date,
    periodEnd: Date,
    now: Date,
  ) {
    const rows = await this.prisma.$queryRaw<
      { plan_id: string; plan_name: string; member_count: bigint; attendances: bigint }[]
    >`
      WITH entitled_members AS (
        SELECT sm.user_id
        FROM studio_memberships sm
        JOIN users u ON u.id = sm.user_id
        WHERE sm.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.exclude_from_analytics = false
          AND sm.deleted_at IS NULL
          AND u.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.studio_id = sm.studio_id AND s.user_id = sm.user_id
              AND (s.current_period_start IS NULL OR s.current_period_start <= ${now})
              AND (
                (s.status IN ('ACTIVE','TRIALING') AND s.entitlement_ends_at IS NULL AND s.current_period_end > ${now})
                OR (s.status IN ('ACTIVE','TRIALING','CANCELED') AND s.entitlement_ends_at > ${now})
              )
          )
      ),
      entitled_member_plans AS (
        SELECT DISTINCT ON (em.user_id)
          em.user_id,
          mp.id AS plan_id,
          mp.name AS plan_name
        FROM entitled_members em
        JOIN subscriptions s ON s.studio_id = ${studioId} AND s.user_id = em.user_id
        JOIN membership_plans mp ON mp.id = s.membership_plan_id
        WHERE (s.current_period_start IS NULL OR s.current_period_start <= ${now})
          AND (
            (s.status IN ('ACTIVE','TRIALING') AND s.entitlement_ends_at IS NULL AND s.current_period_end > ${now})
            OR (s.status IN ('ACTIVE','TRIALING','CANCELED') AND s.entitlement_ends_at > ${now})
          )
        ORDER BY em.user_id, s.created_at DESC
      )
      SELECT
        emp.plan_id,
        emp.plan_name,
        COUNT(DISTINCT emp.user_id) AS member_count,
        COUNT(a.id) AS attendances
      FROM entitled_member_plans emp
      LEFT JOIN attendances a ON a.studio_id = ${studioId}
        AND a.user_id = emp.user_id
        AND a.checked_in_at >= ${periodStart}
        AND a.checked_in_at <= ${periodEnd}
      GROUP BY emp.plan_id, emp.plan_name
      ORDER BY member_count DESC
    `;
    return rows.map((r) => {
      const memberCount = Number(r.member_count);
      const attendances = Number(r.attendances);
      return {
        planId: r.plan_id,
        planName: r.plan_name,
        memberCount,
        avgVisitsPerMember:
          memberCount > 0 ? Math.round((attendances / memberCount) * 10) / 10 : 0,
      };
    });
  }
}
