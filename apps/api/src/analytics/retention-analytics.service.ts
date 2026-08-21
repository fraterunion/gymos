import { Injectable, NotFoundException } from '@nestjs/common';
import { getStudioLocalDateKey, studioLocalCalendarDaysBetween } from '../common/date/studio-local-date';
import { PrismaService } from '../prisma/prisma.service';
import { SQL_ATTENDANCE_EXCLUDE } from './analytics-exclusion.utils';
import { assertStudioTimezone } from './analytics-timezone.utils';
import { computeVisitsPerWeek } from './member-engagement.utils';
import { computeConsecutiveActiveWeekStreak } from './member-analytics-schedule.utils';
import { rollingWindowStart } from './member-analytics-range.utils';
import {
  buildMemberPatternSentence,
  classifyRetentionMember,
  CLASS_STICKINESS_MIN_SAMPLE,
  COHORT_MIN_SIZE,
  isRequiresActionRow,
  retentionActionPriority,
  suggestRetentionAction,
  type RetentionMovement,
} from './retention-engagement.utils';
import type {
  RetentionActivityDto,
  RetentionClassStickinessDto,
  RetentionCohortDto,
  RetentionFrequencyTrendDto,
  RetentionMemberDetailDto,
  RetentionMemberRowDto,
  RetentionMembersDto,
  RetentionSummaryDto,
} from './retention-analytics.types';

type RawRetentionMember = {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  joined_at: Date;
  plan_name: string | null;
  is_entitled: boolean;
  entitlement_ends_at: Date | null;
  visits_30d: bigint;
  visits_prior_30d: bigint;
  visits_60_90d: bigint;
  visits_90d: bigint;
  last_visit_at: Date | null;
  last_visit_before_30d: Date | null;
  first_visit_in_30d: Date | null;
  gap_days_before_return: number | null;
  visits_since_return: bigint | null;
  favorite_class: string | null;
  favorite_time: string | null;
  favorite_instructor: string | null;
  favorite_weekday: number | null;
  week_start_keys: string[];
  consecutive_week_streak: number;
};

/**
 * Analytics 1.1 — attendance-behavior retention (read-only).
 * Attendance inclusion: checkedInAt. Preferences: ScheduledClass.startsAt.
 */
@Injectable()
export class RetentionAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getStudioTimezone(studioId: string): Promise<string> {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { timezone: true },
    });
    if (!studio) throw new NotFoundException('Studio not found');
    return assertStudioTimezone(studio.timezone);
  }

  private async earliestAttendanceAt(studioId: string): Promise<Date | null> {
    const row = await this.prisma.attendance.findFirst({
      where: { studioId },
      orderBy: { checkedInAt: 'asc' },
      select: { checkedInAt: true },
    });
    return row?.checkedInAt ?? null;
  }

  private daysSinceLocal(at: Date | null, now: Date, timezone: string): number | null {
    if (!at) return null;
    return Math.max(0, studioLocalCalendarDaysBetween(at, now, timezone));
  }

  private async loadRetentionMembers(
    studioId: string,
    timezone: string,
    now: Date,
  ): Promise<RawRetentionMember[]> {
    const thirtyStart = rollingWindowStart(now, timezone, 30);
    const sixtyStart = rollingWindowStart(now, timezone, 60);
    const ninetyStart = rollingWindowStart(now, timezone, 90);

    const rows = await this.prisma.$queryRaw<
      Array<Omit<RawRetentionMember, 'week_start_keys' | 'consecutive_week_streak' | 'favorite_class' | 'favorite_time' | 'favorite_instructor' | 'favorite_weekday'> & {
        favorite_class: string | null;
        favorite_time: string | null;
        favorite_instructor: string | null;
        favorite_weekday: number | null;
      }>
    >`
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
              AND (s.current_period_start IS NULL OR s.current_period_start <= ${now})
              AND (
                (s.status IN ('ACTIVE','TRIALING') AND s.entitlement_ends_at IS NULL AND s.current_period_end > ${now})
                OR (s.status IN ('ACTIVE','TRIALING','CANCELED') AND s.entitlement_ends_at > ${now})
              )
          ) AS is_entitled,
          (
            SELECT s.entitlement_ends_at FROM subscriptions s
            WHERE s.studio_id = sm.studio_id AND s.user_id = sm.user_id
              AND (s.current_period_start IS NULL OR s.current_period_start <= ${now})
              AND (
                (s.status IN ('ACTIVE','TRIALING') AND s.entitlement_ends_at IS NULL AND s.current_period_end > ${now})
                OR (s.status IN ('ACTIVE','TRIALING','CANCELED') AND s.entitlement_ends_at > ${now})
              )
            ORDER BY s.created_at DESC LIMIT 1
          ) AS entitlement_ends_at
        FROM studio_memberships sm
        JOIN users u ON u.id = sm.user_id
        LEFT JOIN LATERAL (
          SELECT mp2.name
          FROM subscriptions s2
          JOIN membership_plans mp2 ON mp2.id = s2.membership_plan_id
          WHERE s2.studio_id = sm.studio_id AND s2.user_id = sm.user_id
            AND (s2.current_period_start IS NULL OR s2.current_period_start <= ${now})
            AND (
              (s2.status IN ('ACTIVE','TRIALING') AND s2.entitlement_ends_at IS NULL AND s2.current_period_end > ${now})
              OR (s2.status IN ('ACTIVE','TRIALING','CANCELED') AND s2.entitlement_ends_at > ${now})
            )
          ORDER BY s2.created_at DESC LIMIT 1
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
          COUNT(*) FILTER (WHERE a.checked_in_at >= ${thirtyStart}) AS visits_30d,
          COUNT(*) FILTER (WHERE a.checked_in_at >= ${sixtyStart} AND a.checked_in_at < ${thirtyStart}) AS visits_prior_30d,
          COUNT(*) FILTER (WHERE a.checked_in_at >= ${ninetyStart} AND a.checked_in_at < ${sixtyStart}) AS visits_60_90d,
          COUNT(*) FILTER (WHERE a.checked_in_at >= ${ninetyStart}) AS visits_90d,
          MAX(a.checked_in_at) AS last_visit_at,
          MAX(a.checked_in_at) FILTER (WHERE a.checked_in_at < ${thirtyStart}) AS last_visit_before_30d,
          MIN(a.checked_in_at) FILTER (WHERE a.checked_in_at >= ${thirtyStart}) AS first_visit_in_30d
        FROM attendances a
        JOIN member_base mb ON mb.user_id = a.user_id
        WHERE a.studio_id = ${studioId}
          ${SQL_ATTENDANCE_EXCLUDE}
        GROUP BY a.user_id
      ),
      favorites AS (
        SELECT DISTINCT ON (sub.user_id)
          sub.user_id,
          sub.class_name AS favorite_class,
          sub.schedule_time AS favorite_time,
          sub.instructor_name AS favorite_instructor,
          sub.weekday AS favorite_weekday
        FROM (
          SELECT
            a.user_id,
            ct.name AS class_name,
            to_char(sc.starts_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}, 'HH24:MI') AS schedule_time,
            EXTRACT(DOW FROM (sc.starts_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}))::int AS weekday,
            NULLIF(trim(coalesce(iu.first_name, '') || ' ' || coalesce(iu.last_name, '')), '') AS instructor_name,
            COUNT(*) OVER (PARTITION BY a.user_id, ct.name) AS class_cnt,
            COUNT(*) OVER (
              PARTITION BY a.user_id,
              to_char(sc.starts_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}, 'HH24:MI')
            ) AS time_cnt,
            COUNT(*) OVER (
              PARTITION BY a.user_id,
              EXTRACT(DOW FROM (sc.starts_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}))::int
            ) AS weekday_cnt
          FROM attendances a
          JOIN member_base mb ON mb.user_id = a.user_id
          JOIN scheduled_classes sc ON sc.id = a.scheduled_class_id
          JOIN class_templates ct ON ct.id = sc.class_template_id
          LEFT JOIN users iu ON iu.id = sc.instructor_id
          WHERE a.studio_id = ${studioId}
            AND a.checked_in_at >= ${ninetyStart}
            ${SQL_ATTENDANCE_EXCLUDE}
        ) sub
        ORDER BY sub.user_id, sub.class_cnt DESC, sub.class_name ASC
      )
      SELECT
        mb.user_id,
        mb.first_name,
        mb.last_name,
        mb.email,
        mb.joined_at,
        mb.plan_name,
        mb.is_entitled,
        mb.entitlement_ends_at,
        COALESCE(aa.visits_30d, 0) AS visits_30d,
        COALESCE(aa.visits_prior_30d, 0) AS visits_prior_30d,
        COALESCE(aa.visits_60_90d, 0) AS visits_60_90d,
        COALESCE(aa.visits_90d, 0) AS visits_90d,
        aa.last_visit_at,
        aa.last_visit_before_30d,
        aa.first_visit_in_30d,
        CASE
          WHEN aa.first_visit_in_30d IS NOT NULL AND aa.last_visit_before_30d IS NOT NULL
            THEN FLOOR(EXTRACT(EPOCH FROM (aa.first_visit_in_30d - aa.last_visit_before_30d)) / 86400)::int
          WHEN aa.first_visit_in_30d IS NOT NULL AND aa.last_visit_before_30d IS NULL
            THEN NULL
          ELSE NULL
        END AS gap_days_before_return,
        CASE
          WHEN aa.first_visit_in_30d IS NULL THEN NULL
          ELSE (
            SELECT COUNT(*)::bigint FROM attendances a
            WHERE a.studio_id = ${studioId} AND a.user_id = mb.user_id
              AND a.checked_in_at >= aa.first_visit_in_30d
              ${SQL_ATTENDANCE_EXCLUDE}
          )
        END AS visits_since_return,
        fav.favorite_class,
        fav.favorite_time,
        fav.favorite_instructor,
        fav.favorite_weekday
      FROM member_base mb
      LEFT JOIN attendance_agg aa ON aa.user_id = mb.user_id
      LEFT JOIN favorites fav ON fav.user_id = mb.user_id
    `;

    const weekRows = await this.prisma.$queryRaw<Array<{ user_id: string; week_start: Date }>>`
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

    const weeksByUser = new Map<string, string[]>();
    for (const row of weekRows) {
      const key = row.week_start.toISOString().slice(0, 10);
      const list = weeksByUser.get(row.user_id) ?? [];
      list.push(key);
      weeksByUser.set(row.user_id, list);
    }

    return rows.map((row) => {
      const keys = [...new Set(weeksByUser.get(row.user_id) ?? [])].sort((a, b) =>
        b.localeCompare(a),
      );
      return {
        ...row,
        week_start_keys: keys,
        consecutive_week_streak: computeConsecutiveActiveWeekStreak(keys, now, timezone),
      };
    });
  }

  private mapMemberRow(
    raw: RawRetentionMember,
    now: Date,
    thirtyStart: Date,
    timezone: string,
  ): RetentionMemberRowDto {
    const daysSinceLastVisit = this.daysSinceLocal(raw.last_visit_at, now, timezone);
    let daysSinceLastVisitAtPriorEnd: number | null = null;
    if (raw.last_visit_before_30d) {
      daysSinceLastVisitAtPriorEnd = Math.max(
        0,
        studioLocalCalendarDaysBetween(raw.last_visit_before_30d, thirtyStart, timezone),
      );
    } else if (Number(raw.visits_prior_30d) === 0 && Number(raw.visits_60_90d) === 0) {
      daysSinceLastVisitAtPriorEnd = null;
    }

    const gapDaysBeforeReturn =
      raw.last_visit_before_30d && raw.first_visit_in_30d
        ? Math.max(
            0,
            studioLocalCalendarDaysBetween(
              raw.last_visit_before_30d,
              raw.first_visit_in_30d,
              timezone,
            ),
          )
        : null;

    const classified = classifyRetentionMember({
      visitsLast30d: Number(raw.visits_30d),
      visitsPrior30d: Number(raw.visits_prior_30d),
      visits60to90d: Number(raw.visits_60_90d),
      daysSinceLastVisit,
      daysSinceLastVisitAtPriorEnd,
      gapDaysBeforeReturn,
      visitsSinceReturn:
        raw.visits_since_return != null ? Number(raw.visits_since_return) : null,
      activeWeeksLast90d: raw.week_start_keys.length,
      isEntitled: raw.is_entitled,
    });

    const deltaPct = classified.trendPct;
    const reason =
      classified.recovered.isRecovered && classified.recovered.reasons[0]
        ? classified.recovered.reasons[0]
        : classified.engagement.reasons[0] ??
          (raw.is_entitled ? 'Sin señales destacadas' : 'Membresía no activa');

    const suggestedAction = suggestRetentionAction({
      isEntitled: raw.is_entitled,
      isRecovered: classified.recovered.isRecovered,
      health: classified.retentionHealth,
      movement: classified.movement,
      daysSinceLastVisit,
      entitlementEndsAt: raw.entitlement_ends_at,
      now,
    });

    const favoriteWeekdays =
      raw.favorite_weekday != null ? [raw.favorite_weekday] : [];

    return {
      userId: raw.user_id,
      firstName: raw.first_name,
      lastName: raw.last_name,
      email: raw.email,
      planName: raw.plan_name,
      isEntitled: raw.is_entitled,
      joinedAt: raw.joined_at.toISOString(),
      health: classified.retentionHealth,
      movement: classified.movement,
      lastVisitAt: raw.last_visit_at?.toISOString() ?? null,
      daysSinceLastVisit,
      visits30d: Number(raw.visits_30d),
      visitsPrior30d: Number(raw.visits_prior_30d),
      visits90d: Number(raw.visits_90d),
      deltaPct,
      streak: raw.consecutive_week_streak,
      reason,
      suggestedAction,
      isRecovered: classified.recovered.isRecovered,
      recoveredReasons: classified.recovered.reasons,
      favoriteClass: raw.favorite_class,
      favoriteTime: raw.favorite_time,
      favoriteWeekday: raw.favorite_weekday,
      favoriteInstructor: raw.favorite_instructor,
      patternSentence: buildMemberPatternSentence({
        favoriteWeekdays,
        favoriteTime: raw.favorite_time,
        daysSinceLastVisit,
        visits30d: Number(raw.visits_30d),
        visitsPrior30d: Number(raw.visits_prior_30d),
        trendPct: deltaPct,
        preferenceEvidenceCount: Number(raw.visits_90d),
      }),
      visitsPerWeek: computeVisitsPerWeek(Number(raw.visits_30d), 30),
    };
  }

  async getSummary(studioId: string): Promise<RetentionSummaryDto> {
    const timezone = await this.getStudioTimezone(studioId);
    const now = new Date();
    const thirtyStart = rollingWindowStart(now, timezone, 30);
    const sixtyStart = rollingWindowStart(now, timezone, 60);
    const dataFrom = await this.earliestAttendanceAt(studioId);
    const members = (await this.loadRetentionMembers(studioId, timezone, now)).map((r) =>
      this.mapMemberRow(r, now, thirtyStart, timezone),
    );

    const entitled = members.filter((m) => m.isEntitled);
    const attending = entitled.filter((m) => m.visits30d > 0);
    const attendances30d = entitled.reduce((s, m) => s + m.visits30d, 0);

    return {
      timezone,
      analyticsDataAvailableFrom: dataFrom?.toISOString() ?? null,
      current30Start: thirtyStart.toISOString(),
      current30End: now.toISOString(),
      previous30Start: sixtyStart.toISOString(),
      previous30End: thirtyStart.toISOString(),
      kpis: {
        activeMembers: entitled.length,
        atRisk: entitled.filter((m) => m.health === 'AT_RISK').length,
        inactive: entitled.filter((m) => m.health === 'INACTIVE').length,
        recovered: entitled.filter((m) => m.isRecovered).length,
        observation: entitled.filter((m) => m.health === 'OBSERVATION').length,
        frequencyVisitsNumerator: attendances30d,
        frequencyAttendingDenominator: attending.length,
        frequencyEntitledDenominator: entitled.length,
        frequencyVisitsPerAttending:
          attending.length > 0
            ? Math.round((attendances30d / attending.length) * 10) / 10
            : null,
        frequencyVisitsPerEntitled:
          entitled.length > 0
            ? Math.round((attendances30d / entitled.length) * 10) / 10
            : null,
      },
      populations: {
        allMembers: members.length,
        entitled: entitled.length,
        lapsed: members.length - entitled.length,
        attending30d: attending.length,
      },
    };
  }

  async listMembers(
    studioId: string,
    query: {
      search?: string;
      health?: string;
      movement?: string;
      entitlement?: 'entitled' | 'lapsed' | 'all';
      sort?: string;
      order?: 'asc' | 'desc';
      page?: number;
      limit?: number;
    },
  ): Promise<RetentionMembersDto> {
    const timezone = await this.getStudioTimezone(studioId);
    const now = new Date();
    const thirtyStart = rollingWindowStart(now, timezone, 30);
    let rows = (await this.loadRetentionMembers(studioId, timezone, now)).map((r) =>
      this.mapMemberRow(r, now, thirtyStart, timezone),
    );

    const entitlement = query.entitlement ?? 'all';
    if (entitlement === 'entitled') rows = rows.filter((r) => r.isEntitled);
    if (entitlement === 'lapsed') rows = rows.filter((r) => !r.isEntitled);

    if (query.health) {
      rows = rows.filter((r) => r.health === query.health);
    }
    if (query.movement) {
      rows = rows.filter((r) => r.movement === query.movement);
    }
    if (query.search?.trim()) {
      const q = query.search.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.firstName.toLowerCase().includes(q) ||
          r.lastName.toLowerCase().includes(q) ||
          (r.email?.toLowerCase().includes(q) ?? false),
      );
    }

    const orderMul = query.order === 'asc' ? 1 : -1;
    const sort = query.sort ?? 'risk';
    rows.sort((a, b) => {
      switch (sort) {
        case 'decline':
          return orderMul * ((a.deltaPct ?? 0) - (b.deltaPct ?? 0));
        case 'absence':
          return orderMul * ((a.daysSinceLastVisit ?? 9999) - (b.daysSinceLastVisit ?? 9999));
        case 'active':
          return orderMul * (a.visits30d - b.visits30d);
        case 'recovered':
          return orderMul * (Number(a.isRecovered) - Number(b.isRecovered));
        case 'risk':
        default:
          return (
            orderMul *
            (retentionActionPriority({
              health: a.health,
              daysSinceLastVisit: a.daysSinceLastVisit,
              trendPct: a.deltaPct,
              isRecovered: a.isRecovered,
            }) -
              retentionActionPriority({
                health: b.health,
                daysSinceLastVisit: b.daysSinceLastVisit,
                trendPct: b.deltaPct,
                isRecovered: b.isRecovered,
              }))
          );
      }
    });

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const start = (page - 1) * limit;
    return {
      data: rows.slice(start, start + limit),
      total: rows.length,
      page,
      limit,
    };
  }

  async getActivity(studioId: string): Promise<RetentionActivityDto> {
    const timezone = await this.getStudioTimezone(studioId);
    const now = new Date();
    const thirtyStart = rollingWindowStart(now, timezone, 30);
    const dataFrom = await this.earliestAttendanceAt(studioId);
    const members = (await this.loadRetentionMembers(studioId, timezone, now)).map((r) =>
      this.mapMemberRow(r, now, thirtyStart, timezone),
    );

    const requiresAction = members
      .filter((m) =>
        isRequiresActionRow({
          isEntitled: m.isEntitled,
          health: m.health,
          isRecovered: m.isRecovered,
        }),
      )
      .sort(
        (a, b) =>
          retentionActionPriority({
            health: b.health,
            daysSinceLastVisit: b.daysSinceLastVisit,
            trendPct: b.deltaPct,
            isRecovered: b.isRecovered,
          }) -
          retentionActionPriority({
            health: a.health,
            daysSinceLastVisit: a.daysSinceLastVisit,
            trendPct: a.deltaPct,
            isRecovered: a.isRecovered,
          }),
      )
      .slice(0, 50);

    const movementCounts = new Map<RetentionMovement, number>();
    for (const m of members.filter((x) => x.isEntitled)) {
      movementCounts.set(m.movement, (movementCounts.get(m.movement) ?? 0) + 1);
    }

    const [cohorts, classStickiness, frequencyTrend] = await Promise.all([
      this.loadCohorts(studioId, timezone, now, dataFrom),
      this.loadClassStickiness(studioId, timezone, now),
      this.loadFrequencyTrend(studioId, timezone, now),
    ]);

    const limitedHistoryMessage =
      dataFrom == null
        ? 'Aún no hay suficiente historial para calcular esta métrica con confianza.'
        : null;

    return {
      timezone,
      analyticsDataAvailableFrom: dataFrom?.toISOString() ?? null,
      requiresAction,
      movement: [...movementCounts.entries()].map(([movement, count]) => ({ movement, count })),
      cohorts,
      classStickiness,
      frequencyTrend,
      limitedHistoryMessage,
    };
  }

  async getMemberDetail(studioId: string, userId: string): Promise<RetentionMemberDetailDto> {
    const timezone = await this.getStudioTimezone(studioId);
    const now = new Date();
    const thirtyStart = rollingWindowStart(now, timezone, 30);
    const members = await this.loadRetentionMembers(studioId, timezone, now);
    const raw = members.find((m) => m.user_id === userId);
    if (!raw) throw new NotFoundException('Member not found');
    const row = this.mapMemberRow(raw, now, thirtyStart, timezone);

    const months = await this.prisma.$queryRaw<
      Array<{ month: string; attendances: bigint }>
    >`
      SELECT to_char(
               date_trunc('month', a.checked_in_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}),
               'YYYY-MM'
             ) AS month,
             COUNT(*) AS attendances
      FROM attendances a
      WHERE a.studio_id = ${studioId} AND a.user_id = ${userId}
        ${SQL_ATTENDANCE_EXCLUDE}
      GROUP BY 1
      ORDER BY 1
    `;
    const currentMonthKey = getStudioLocalDateKey(now, timezone).slice(0, 7);

    return {
      ...row,
      monthlyTrend: months.map((m) => ({
        month: m.month,
        attendances: Number(m.attendances),
        isPartial: m.month === currentMonthKey,
      })),
    };
  }

  private async loadCohorts(
    studioId: string,
    timezone: string,
    now: Date,
    dataFrom: Date | null,
  ): Promise<RetentionCohortDto[]> {
    if (!dataFrom) return [];

    const dataFromDateKey = getStudioLocalDateKey(dataFrom, timezone);
    const dataFromKey = dataFromDateKey.slice(0, 7);
    const dataFromDay = Number(dataFromDateKey.slice(8, 10));
    const nowKey = getStudioLocalDateKey(now, timezone).slice(0, 7);

    const attMonths = await this.prisma.$queryRaw<
      Array<{ user_id: string; att_month: string }>
    >`
      SELECT DISTINCT a.user_id,
             to_char(
               date_trunc('month', a.checked_in_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}),
               'YYYY-MM'
             ) AS att_month
      FROM attendances a
      JOIN studio_memberships sm ON sm.studio_id = a.studio_id AND sm.user_id = a.user_id
      WHERE a.studio_id = ${studioId}
        AND sm.role = 'MEMBER'
        AND sm.exclude_from_analytics = false
        ${SQL_ATTENDANCE_EXCLUDE}
    `;

    const attByUser = new Map<string, Set<string>>();
    for (const row of attMonths) {
      const set = attByUser.get(row.user_id) ?? new Set();
      set.add(row.att_month);
      attByUser.set(row.user_id, set);
    }

    const joins = await this.prisma.$queryRaw<
      Array<{ user_id: string; join_month: string }>
    >`
      SELECT sm.user_id,
             to_char(
               date_trunc('month', sm.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}),
               'YYYY-MM'
             ) AS join_month
      FROM studio_memberships sm
      WHERE sm.studio_id = ${studioId}
        AND sm.role = 'MEMBER'
        AND sm.exclude_from_analytics = false
        AND sm.deleted_at IS NULL
    `;

    const byCohort = new Map<string, string[]>();
    for (const row of joins) {
      const list = byCohort.get(row.join_month) ?? [];
      list.push(row.user_id);
      byCohort.set(row.join_month, list);
    }

    const monthAdd = (ym: string, offset: number): string => {
      const [y, m] = ym.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + offset, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };

    const monthsElapsed = (from: string, to: string): number => {
      const [fy, fm] = from.split('-').map(Number);
      const [ty, tm] = to.split('-').map(Number);
      return (ty - fy) * 12 + (tm - fm);
    };

    const cohorts: RetentionCohortDto[] = [];
    for (const [cohortMonth, userIds] of [...byCohort.entries()].sort()) {
      const size = userIds.length;
      const cohortSuppressed = size < COHORT_MIN_SIZE;
      // Pre-data history: if cohort month is before first attendance month, annotate
      const preData = cohortMonth < dataFromKey;
      const maxOffset = Math.min(3, monthsElapsed(cohortMonth, nowKey));
      const cells = [];
      for (let offset = 0; offset <= 3; offset++) {
        const targetMonth = monthAdd(cohortMonth, offset);
        const immature = offset > maxOffset;
        const cellPreData = targetMonth < dataFromKey;
        let suppressed = immature || cellPreData || cohortSuppressed;
        let suppressReason: string | null = null;
        if (immature) suppressReason = 'Mes aún no transcurrido';
        else if (cellPreData) {
          suppressReason = 'Historial de asistencia aún no disponible';
          suppressed = true;
        } else if (cohortSuppressed) suppressReason = 'Cohorte pequeña';

        // June-like: entire cohort month before trustworthy attendance — suppress M0 even if same calendar quirks
        if (preData && offset === 0) {
          suppressed = true;
          suppressReason =
            suppressReason ??
            'La cohorte precede al historial confiable de asistencia';
        }

        const retained = suppressed
          ? 0
          : userIds.filter((id) => attByUser.get(id)?.has(targetMonth)).length;

        // Mid-month data start: early days of this lifecycle month were unobserved.
        const limitedHistoryCoverage =
          !suppressed && targetMonth === dataFromKey && dataFromDay > 1;
        const limitedHistoryReason = limitedHistoryCoverage
          ? 'Cobertura parcial: el historial confiable de asistencia inicia a mitad de este mes'
          : null;

        cells.push({
          monthOffset: offset,
          retained: suppressed ? 0 : retained,
          cohortSize: size,
          ratePct: suppressed || size === 0 ? null : Math.round((retained / size) * 100),
          suppressed,
          suppressReason,
          limitedHistoryCoverage,
          limitedHistoryReason,
        });
      }

      cohorts.push({
        cohortMonth,
        cohortSize: size,
        suppressed: cohortSuppressed || preData,
        suppressReason: preData
          ? 'La cohorte precede al historial confiable de asistencia'
          : cohortSuppressed
            ? `Menos de ${COHORT_MIN_SIZE} miembros`
            : null,
        cells,
      });
    }

    return cohorts.sort((a, b) => b.cohortMonth.localeCompare(a.cohortMonth));
  }

  private async loadClassStickiness(
    studioId: string,
    timezone: string,
    now: Date,
  ): Promise<RetentionClassStickinessDto[]> {
    // Seed window ends 30d ago (so 30d return has elapsed). Start from earliest
    // of (now-90d) so short studios still accumulate enough seed members.
    const seedEnd = rollingWindowStart(now, timezone, 30);
    const seedStart = rollingWindowStart(now, timezone, 90);

    const rows = await this.prisma.$queryRaw<
      Array<{
        class_template_id: string;
        class_name: string;
        unique_members: bigint;
        attendances: bigint;
        seed_members: bigint;
        returned_7d: bigint;
        returned_14d: bigint;
        returned_30d: bigint;
      }>
    >`
      WITH period_att AS (
        SELECT a.user_id, ct.id AS class_template_id, ct.name AS class_name, a.checked_in_at
        FROM attendances a
        JOIN scheduled_classes sc ON sc.id = a.scheduled_class_id
        JOIN class_templates ct ON ct.id = sc.class_template_id
        JOIN studio_memberships sm ON sm.studio_id = a.studio_id AND sm.user_id = a.user_id
        WHERE a.studio_id = ${studioId}
          AND sm.role = 'MEMBER'
          AND sm.exclude_from_analytics = false
          AND sm.deleted_at IS NULL
          AND a.checked_in_at >= ${seedStart}
          ${SQL_ATTENDANCE_EXCLUDE}
      ),
      class_totals AS (
        SELECT class_template_id, class_name,
               COUNT(DISTINCT user_id) AS unique_members,
               COUNT(*) AS attendances
        FROM period_att
        WHERE checked_in_at >= ${seedStart}
        GROUP BY class_template_id, class_name
      ),
      seeds AS (
        SELECT user_id, class_template_id, class_name, MIN(checked_in_at) AS first_att
        FROM period_att
        WHERE checked_in_at >= ${seedStart} AND checked_in_at < ${seedEnd}
        GROUP BY user_id, class_template_id, class_name
      ),
      seed_stats AS (
        SELECT s.class_template_id, s.class_name,
               COUNT(*) AS seed_members,
               COUNT(*) FILTER (
                 WHERE EXISTS (
                   SELECT 1 FROM attendances a
                   WHERE a.studio_id = ${studioId} AND a.user_id = s.user_id
                     AND a.checked_in_at > s.first_att
                     AND a.checked_in_at <= s.first_att + interval '7 days'
                     ${SQL_ATTENDANCE_EXCLUDE}
                 )
               ) AS returned_7d,
               COUNT(*) FILTER (
                 WHERE EXISTS (
                   SELECT 1 FROM attendances a
                   WHERE a.studio_id = ${studioId} AND a.user_id = s.user_id
                     AND a.checked_in_at > s.first_att
                     AND a.checked_in_at <= s.first_att + interval '14 days'
                     ${SQL_ATTENDANCE_EXCLUDE}
                 )
               ) AS returned_14d,
               COUNT(*) FILTER (
                 WHERE EXISTS (
                   SELECT 1 FROM attendances a
                   WHERE a.studio_id = ${studioId} AND a.user_id = s.user_id
                     AND a.checked_in_at > s.first_att
                     AND a.checked_in_at <= s.first_att + interval '30 days'
                     ${SQL_ATTENDANCE_EXCLUDE}
                 )
               ) AS returned_30d
        FROM seeds s
        GROUP BY s.class_template_id, s.class_name
      )
      SELECT
        ct.class_template_id,
        ct.class_name,
        ct.unique_members,
        ct.attendances,
        COALESCE(ss.seed_members, 0) AS seed_members,
        COALESCE(ss.returned_7d, 0) AS returned_7d,
        COALESCE(ss.returned_14d, 0) AS returned_14d,
        COALESCE(ss.returned_30d, 0) AS returned_30d
      FROM class_totals ct
      LEFT JOIN seed_stats ss ON ss.class_template_id = ct.class_template_id
      ORDER BY ct.unique_members DESC, ct.class_name ASC
    `;

    return rows.map((r) => {
      const seed = Number(r.seed_members);
      const insufficient = seed < CLASS_STICKINESS_MIN_SAMPLE;
      const rate = (n: number) =>
        insufficient || seed === 0 ? null : Math.round((n / seed) * 100);
      const unique = Number(r.unique_members);
      const att = Number(r.attendances);
      return {
        classTemplateId: r.class_template_id,
        className: r.class_name,
        uniqueMembers: unique,
        attendances: att,
        avgVisitsPerMember: unique > 0 ? Math.round((att / unique) * 10) / 10 : 0,
        seedMembers: seed,
        return7dRatePct: rate(Number(r.returned_7d)),
        return14dRatePct: rate(Number(r.returned_14d)),
        return30dRatePct: rate(Number(r.returned_30d)),
        sampleInsufficient: insufficient,
      };
    });
  }

  private async loadFrequencyTrend(
    studioId: string,
    timezone: string,
    now: Date,
  ): Promise<RetentionFrequencyTrendDto[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ month: string; attendances: bigint; unique_members: bigint }>
    >`
      SELECT to_char(
               date_trunc('month', a.checked_in_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}),
               'YYYY-MM'
             ) AS month,
             COUNT(*) AS attendances,
             COUNT(DISTINCT a.user_id) AS unique_members
      FROM attendances a
      JOIN studio_memberships sm ON sm.studio_id = a.studio_id AND sm.user_id = a.user_id
      WHERE a.studio_id = ${studioId}
        AND sm.role = 'MEMBER'
        AND sm.exclude_from_analytics = false
        AND sm.deleted_at IS NULL
        ${SQL_ATTENDANCE_EXCLUDE}
      GROUP BY 1
      ORDER BY 1
    `;
    const currentMonthKey = getStudioLocalDateKey(now, timezone).slice(0, 7);
    return rows.map((r) => {
      const key = r.month;
      const att = Number(r.attendances);
      const uniq = Number(r.unique_members);
      return {
        month: key,
        attendances: att,
        uniqueAttending: uniq,
        visitsPerAttending: uniq > 0 ? Math.round((att / uniq) * 10) / 10 : null,
        isPartial: key === currentMonthKey,
        isCurrentMonth: key === currentMonthKey,
      };
    });
  }
}
