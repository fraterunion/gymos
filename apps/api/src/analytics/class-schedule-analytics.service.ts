import { Injectable, NotFoundException } from '@nestjs/common';
import {
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
} from '../common/date/studio-local-date';
import { PrismaService } from '../prisma/prisma.service';
import { assertStudioTimezone } from './analytics-timezone.utils';
import {
  MEMBER_ANALYTICS_PERIOD_LABELS,
  memberAnalyticsPeriodWindows,
  type MemberAnalyticsPeriodKey,
} from './member-analytics-range.utils';
import {
  buildClassTimeInsight,
  buildOpportunities,
  CLASS_RANKING_MIN_ACTIVE_SESSIONS,
  CLASS_TIME_COMPARE_MIN_SESSIONS,
  classifyDemandBand,
  computeShowRatePct,
  isActiveSession,
  isEmptySession,
  pct,
  round1,
  SLOT_RECOMMENDATION_MIN_SESSIONS,
  type SessionFact,
} from './class-schedule-engagement.utils';
import type {
  ClassScheduleActivityDto,
  ClassScheduleHeatmapCellDto,
  ClassScheduleSlotRowDto,
  ClassScheduleSummaryDto,
  ClassTemplateDetailDto,
  ClassTemplateRowDto,
} from './class-schedule-analytics.types';

type RawSessionRow = {
  scheduled_class_id: string;
  class_template_id: string;
  class_name: string;
  capacity: number;
  starts_at: Date;
  weekday: number;
  schedule_time: string;
  hour: number;
  attendances: bigint | number;
  confirmed_bookings: bigint | number;
  confirmed_attended: bigint | number;
};

type UniqueMemberRow = {
  class_template_id: string;
  unique_members: bigint | number;
};

const CLASS_PERIOD_KEYS = [
  'this_month',
  'prev_month',
  'last_7d',
  'last_30d',
  'last_90d',
  'this_year',
  'custom',
] as const;

@Injectable()
export class ClassScheduleAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private parsePeriod(period?: string): MemberAnalyticsPeriodKey {
    if (CLASS_PERIOD_KEYS.includes(period as (typeof CLASS_PERIOD_KEYS)[number])) {
      return period as MemberAnalyticsPeriodKey;
    }
    return 'last_30d';
  }

  private async getStudioTimezone(studioId: string): Promise<string> {
    const studio = await this.prisma.studio.findUnique({
      where: { id: studioId },
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

  /**
   * Trusted schedule floor = start of the studio-local calendar day of first attendance.
   * Avoids dropping same-day morning sessions that started before the first check-in timestamp.
   */
  private trustedScheduleFloor(dataFrom: Date | null, timezone: string): Date | null {
    if (!dataFrom) return null;
    const dayKey = getStudioLocalDateKey(dataFrom, timezone);
    return studioLocalDateKeyToUtcAnchor(dayKey, timezone);
  }

  private async loadSessionFacts(
    studioId: string,
    timezone: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<SessionFact[]> {
    const rows = await this.prisma.$queryRaw<RawSessionRow[]>`
      SELECT
        sc.id AS scheduled_class_id,
        sc.class_template_id,
        ct.name AS class_name,
        sc.capacity,
        sc.starts_at,
        EXTRACT(DOW FROM (sc.starts_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}))::int AS weekday,
        to_char(sc.starts_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}, 'HH24:MI') AS schedule_time,
        EXTRACT(HOUR FROM (sc.starts_at AT TIME ZONE 'UTC' AT TIME ZONE ${timezone}))::int AS hour,
        (
          SELECT COUNT(*)::int FROM attendances a
          WHERE a.scheduled_class_id = sc.id
        ) AS attendances,
        (
          SELECT COUNT(*)::int FROM bookings b
          WHERE b.scheduled_class_id = sc.id AND b.status = 'CONFIRMED'
        ) AS confirmed_bookings,
        (
          SELECT COUNT(*)::int FROM bookings b
          WHERE b.scheduled_class_id = sc.id
            AND b.status = 'CONFIRMED'
            AND EXISTS (
              SELECT 1 FROM attendances a
              WHERE a.scheduled_class_id = b.scheduled_class_id
                AND a.user_id = b.user_id
            )
        ) AS confirmed_attended
      FROM scheduled_classes sc
      JOIN class_templates ct ON ct.id = sc.class_template_id
      WHERE sc.studio_id = ${studioId}
        AND sc.status = 'SCHEDULED'
        AND sc.starts_at >= ${periodStart}
        AND sc.starts_at <= ${periodEnd}
        AND sc.starts_at < NOW()
        AND sc.capacity > 0
        AND ct.is_open_gym_slot = false
        AND (ct.deleted_at IS NULL)
      ORDER BY sc.starts_at DESC
    `;

    return rows.map((r) => ({
      scheduledClassId: r.scheduled_class_id,
      classTemplateId: r.class_template_id,
      className: r.class_name,
      capacity: Number(r.capacity),
      startsAt: r.starts_at,
      weekday: Number(r.weekday),
      scheduleTime: r.schedule_time,
      hour: Number(r.hour),
      attendances: Number(r.attendances),
      confirmedBookings: Number(r.confirmed_bookings),
      confirmedAttended: Number(r.confirmed_attended),
    }));
  }

  private async loadUniqueMembers(
    studioId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<UniqueMemberRow[]>`
      SELECT sc.class_template_id, COUNT(DISTINCT a.user_id)::int AS unique_members
      FROM attendances a
      JOIN scheduled_classes sc ON sc.id = a.scheduled_class_id
      JOIN class_templates ct ON ct.id = sc.class_template_id
      WHERE a.studio_id = ${studioId}
        AND sc.status = 'SCHEDULED'
        AND sc.starts_at >= ${periodStart}
        AND sc.starts_at <= ${periodEnd}
        AND sc.starts_at < NOW()
        AND sc.capacity > 0
        AND ct.is_open_gym_slot = false
      GROUP BY sc.class_template_id
    `;
    return new Map(rows.map((r) => [r.class_template_id, Number(r.unique_members)]));
  }

  private async resolveContext(
    studioId: string,
    periodRaw?: string,
    from?: string,
    to?: string,
  ) {
    const timezone = await this.getStudioTimezone(studioId);
    const now = new Date();
    const period = this.parsePeriod(periodRaw);
    const windows = memberAnalyticsPeriodWindows(now, timezone, period, from, to);
    const dataFrom = await this.earliestAttendanceAt(studioId);
    const floor = this.trustedScheduleFloor(dataFrom, timezone);
    let effectiveStart = windows.periodStart;
    let trustedFloorApplied = false;
    if (floor && floor.getTime() > effectiveStart.getTime()) {
      effectiveStart = floor;
      trustedFloorApplied = true;
    }
    const facts = await this.loadSessionFacts(
      studioId,
      timezone,
      effectiveStart,
      windows.periodEnd,
    );
    const uniqueByClass = await this.loadUniqueMembers(
      studioId,
      effectiveStart,
      windows.periodEnd,
    );
    return {
      timezone,
      now,
      period,
      windows,
      dataFrom,
      effectiveStart,
      trustedFloorApplied,
      facts,
      uniqueByClass,
    };
  }

  private aggregateTemplates(
    facts: SessionFact[],
    uniqueByClass: Map<string, number>,
  ): ClassTemplateRowDto[] {
    const by = new Map<string, SessionFact[]>();
    for (const f of facts) {
      const list = by.get(f.classTemplateId) ?? [];
      list.push(f);
      by.set(f.classTemplateId, list);
    }
    const rows: ClassTemplateRowDto[] = [];
    for (const [id, list] of by) {
      const active = list.filter(isActiveSession);
      const empty = list.filter(isEmptySession);
      const attendances = list.reduce((s, x) => s + x.attendances, 0);
      const conf = list.reduce((s, x) => s + x.confirmedBookings, 0);
      const confAtt = list.reduce((s, x) => s + x.confirmedAttended, 0);
      const activeCap = active.reduce((s, x) => s + x.capacity, 0);
      const caps = active.map((x) => x.capacity);
      const capacityTypical =
        caps.length === 0
          ? null
          : caps.every((c) => c === caps[0])
            ? caps[0]!
            : null;
      rows.push({
        classTemplateId: id,
        className: list[0]!.className,
        scheduledSessions: list.length,
        activeSessions: active.length,
        emptySessions: empty.length,
        emptyRatePct: pct(empty.length, list.length),
        attendances,
        uniqueMembers: uniqueByClass.get(id) ?? 0,
        avgAttendancePerActiveSession:
          active.length > 0 ? round1(attendances / active.length) : null,
        avgBookingsPerActiveSession:
          active.length > 0
            ? round1(active.reduce((s, x) => s + x.confirmedBookings, 0) / active.length)
            : null,
        showRatePct: computeShowRatePct(confAtt, conf),
        attendanceOccupancyPct: activeCap > 0 ? pct(attendances, activeCap) : null,
        bookingOccupancyPct:
          activeCap > 0
            ? pct(
                active.reduce((s, x) => s + x.confirmedBookings, 0),
                activeCap,
              )
            : null,
        sampleInsufficient: active.length < CLASS_RANKING_MIN_ACTIVE_SESSIONS,
        capacityTypical,
      });
    }
    return rows.sort((a, b) => {
      // Prefer sufficient sample, then avg attendance
      if (a.sampleInsufficient !== b.sampleInsufficient) {
        return a.sampleInsufficient ? 1 : -1;
      }
      return (
        (b.avgAttendancePerActiveSession ?? -1) - (a.avgAttendancePerActiveSession ?? -1) ||
        b.attendances - a.attendances
      );
    });
  }

  private aggregateSlots(facts: SessionFact[]): Array<
    ClassScheduleSlotRowDto & { confirmedBookings: number }
  > {
    const by = new Map<string, SessionFact[]>();
    for (const f of facts) {
      const key = `${f.weekday}|${f.scheduleTime}`;
      const list = by.get(key) ?? [];
      list.push(f);
      by.set(key, list);
    }
    const rows: Array<ClassScheduleSlotRowDto & { confirmedBookings: number }> = [];
    for (const [, list] of by) {
      const active = list.filter(isActiveSession);
      const empty = list.filter(isEmptySession);
      const attendances = list.reduce((s, x) => s + x.attendances, 0);
      const conf = list.reduce((s, x) => s + x.confirmedBookings, 0);
      const confAtt = list.reduce((s, x) => s + x.confirmedAttended, 0);
      const capSum = list.reduce((s, x) => s + x.capacity, 0);
      const avgAtt = list.length > 0 ? round1(attendances / list.length) : null;
      const band = classifyDemandBand({
        avgAttendance: avgAtt,
        sampleSize: list.length,
      });
      rows.push({
        weekday: list[0]!.weekday,
        scheduleTime: list[0]!.scheduleTime,
        scheduledSessions: list.length,
        activeSessions: active.length,
        emptySessions: empty.length,
        emptyRatePct: pct(empty.length, list.length),
        avgAttendance: avgAtt,
        avgBookings: list.length > 0 ? round1(conf / list.length) : null,
        showRatePct: computeShowRatePct(confAtt, conf),
        attendanceOccupancyPct: capSum > 0 ? pct(attendances, capSum) : null,
        bookingOccupancyPct: capSum > 0 ? pct(conf, capSum) : null,
        band,
        sampleInsufficient: list.length < SLOT_RECOMMENDATION_MIN_SESSIONS,
        totalAttendances: attendances,
        confirmedBookings: conf,
      });
    }
    return rows.sort(
      (a, b) =>
        (b.avgAttendance ?? -1) - (a.avgAttendance ?? -1) ||
        b.scheduledSessions - a.scheduledSessions,
    );
  }

  private buildHeatmap(facts: SessionFact[]): ClassScheduleHeatmapCellDto[] {
    const by = new Map<string, SessionFact[]>();
    for (const f of facts) {
      const key = `${f.weekday}|${f.hour}|${f.scheduleTime}`;
      const list = by.get(key) ?? [];
      list.push(f);
      by.set(key, list);
    }
    const cells: ClassScheduleHeatmapCellDto[] = [];
    for (const [, list] of by) {
      const active = list.filter(isActiveSession);
      const empty = list.filter(isEmptySession);
      const attendances = list.reduce((s, x) => s + x.attendances, 0);
      const conf = list.reduce((s, x) => s + x.confirmedBookings, 0);
      const capSum = list.reduce((s, x) => s + x.capacity, 0);
      cells.push({
        weekday: list[0]!.weekday,
        hour: list[0]!.hour,
        scheduleTime: list[0]!.scheduleTime,
        sessions: list.length,
        activeSessions: active.length,
        emptySessions: empty.length,
        avgAttendance: list.length > 0 ? round1(attendances / list.length) : null,
        avgBookings: list.length > 0 ? round1(conf / list.length) : null,
        attendanceOccupancyPct: capSum > 0 ? pct(attendances, capSum) : null,
        bookingOccupancyPct: capSum > 0 ? pct(conf, capSum) : null,
        totalAttendances: attendances,
      });
    }
    return cells.sort(
      (a, b) => a.weekday - b.weekday || a.hour - b.hour || a.scheduleTime.localeCompare(b.scheduleTime),
    );
  }

  async getSummary(
    studioId: string,
    periodRaw?: string,
    from?: string,
    to?: string,
  ): Promise<ClassScheduleSummaryDto> {
    const ctx = await this.resolveContext(studioId, periodRaw, from, to);
    const { facts } = ctx;
    const active = facts.filter(isActiveSession);
    const empty = facts.filter(isEmptySession);
    const attendances = facts.reduce((s, x) => s + x.attendances, 0);
    const conf = facts.reduce((s, x) => s + x.confirmedBookings, 0);
    const confAtt = facts.reduce((s, x) => s + x.confirmedAttended, 0);
    const capAll = facts.reduce((s, x) => s + x.capacity, 0);
    const capActive = active.reduce((s, x) => s + x.capacity, 0);
    const attActive = active.reduce((s, x) => s + x.attendances, 0);

    return {
      timezone: ctx.timezone,
      period: ctx.period,
      periodLabel: MEMBER_ANALYTICS_PERIOD_LABELS[ctx.period],
      periodStart: ctx.windows.periodStart.toISOString(),
      periodEnd: ctx.windows.periodEnd.toISOString(),
      isPartialPeriod: ctx.windows.isPartialPeriod,
      analyticsDataAvailableFrom: ctx.dataFrom?.toISOString() ?? null,
      effectivePeriodStart: ctx.effectiveStart.toISOString(),
      trustedFloorApplied: ctx.trustedFloorApplied,
      instructorAttributionSufficient: false,
      waitlistAnalyticsAvailable: false,
      kpis: {
        activeSessions: active.length,
        scheduledSessions: facts.length,
        emptySessions: empty.length,
        emptySessionRatePct: pct(empty.length, facts.length),
        attendances,
        avgAttendancePerActiveSession:
          active.length > 0 ? round1(attActive / active.length) : null,
        showRatePct: computeShowRatePct(confAtt, conf),
        confirmedBookings: conf,
        confirmedAttended: confAtt,
        capacityUtilizationPct: capAll > 0 ? pct(attendances, capAll) : null,
        capacityUtilizationActivePct: capActive > 0 ? pct(attActive, capActive) : null,
      },
    };
  }

  async getActivity(
    studioId: string,
    periodRaw?: string,
    from?: string,
    to?: string,
  ): Promise<ClassScheduleActivityDto> {
    const ctx = await this.resolveContext(studioId, periodRaw, from, to);
    const slots = this.aggregateSlots(ctx.facts);

    // Class × slot for opportunities
    const classSlotMap = new Map<string, SessionFact[]>();
    for (const f of ctx.facts) {
      if (!isActiveSession(f)) continue;
      const key = `${f.classTemplateId}|${f.weekday}|${f.scheduleTime}`;
      const list = classSlotMap.get(key) ?? [];
      list.push(f);
      classSlotMap.set(key, list);
    }
    const classSlots = [...classSlotMap.entries()].map(([, list]) => ({
      classTemplateId: list[0]!.classTemplateId,
      className: list[0]!.className,
      weekday: list[0]!.weekday,
      scheduleTime: list[0]!.scheduleTime,
      sessions: list.length,
      activeSessions: list.length,
      avgAttendance: round1(list.reduce((s, x) => s + x.attendances, 0) / list.length),
    }));

    const studioShow = computeShowRatePct(
      ctx.facts.reduce((s, x) => s + x.confirmedAttended, 0),
      ctx.facts.reduce((s, x) => s + x.confirmedBookings, 0),
    );

    const opportunities = buildOpportunities({
      slots: slots.map((s) => ({
        weekday: s.weekday,
        scheduleTime: s.scheduleTime,
        scheduledSessions: s.scheduledSessions,
        activeSessions: s.activeSessions,
        emptySessions: s.emptySessions,
        emptyRatePct: s.emptyRatePct,
        avgAttendance: s.avgAttendance,
        showRatePct: s.showRatePct,
        confirmedBookings: s.confirmedBookings,
      })),
      classSlots,
      studioShowRatePct: studioShow,
    }).map((opp) => {
      const { rankScore: _rankScore, ...rest } = opp;
      void _rankScore;
      return rest;
    });

    return {
      timezone: ctx.timezone,
      period: ctx.period,
      periodLabel: MEMBER_ANALYTICS_PERIOD_LABELS[ctx.period],
      isPartialPeriod: ctx.windows.isPartialPeriod,
      analyticsDataAvailableFrom: ctx.dataFrom?.toISOString() ?? null,
      opportunities,
      heatmap: this.buildHeatmap(ctx.facts),
      heatmapDefaultMetric: 'avg_attendance',
      instructorNote: 'Atribución de instructor insuficiente para análisis.',
      waitlistNote:
        'Lista de espera e intentos de clase llena no están disponibles como métricas confiables todavía.',
    };
  }

  async listTemplates(
    studioId: string,
    periodRaw?: string,
    from?: string,
    to?: string,
  ): Promise<{ data: ClassTemplateRowDto[] }> {
    const ctx = await this.resolveContext(studioId, periodRaw, from, to);
    return { data: this.aggregateTemplates(ctx.facts, ctx.uniqueByClass) };
  }

  async listSlots(
    studioId: string,
    periodRaw?: string,
    from?: string,
    to?: string,
  ): Promise<{ data: ClassScheduleSlotRowDto[] }> {
    const ctx = await this.resolveContext(studioId, periodRaw, from, to);
    const slots = this.aggregateSlots(ctx.facts).map((row) => {
      const { confirmedBookings, ...rest } = row;
      void confirmedBookings;
      return rest;
    });
    return { data: slots };
  }

  async getTemplateDetail(
    studioId: string,
    classTemplateId: string,
    periodRaw?: string,
    from?: string,
    to?: string,
  ): Promise<ClassTemplateDetailDto> {
    const ctx = await this.resolveContext(studioId, periodRaw, from, to);
    const facts = ctx.facts.filter((f) => f.classTemplateId === classTemplateId);
    if (facts.length === 0) {
      // Still allow empty template if it exists
      const tpl = await this.prisma.classTemplate.findFirst({
        where: { id: classTemplateId, studioId },
        select: { id: true, name: true },
      });
      if (!tpl) throw new NotFoundException('Class template not found');
      return {
        classTemplateId: tpl.id,
        className: tpl.name,
        scheduledSessions: 0,
        activeSessions: 0,
        emptySessions: 0,
        emptyRatePct: null,
        attendances: 0,
        uniqueMembers: 0,
        avgAttendancePerActiveSession: null,
        avgBookingsPerActiveSession: null,
        showRatePct: null,
        attendanceOccupancyPct: null,
        bookingOccupancyPct: null,
        sampleInsufficient: true,
        capacityTypical: null,
        bySlot: [],
        recentSessions: [],
        insight: null,
        insightEvidence: null,
      };
    }

    const row = this.aggregateTemplates(facts, ctx.uniqueByClass)[0]!;

    const slotMap = new Map<string, SessionFact[]>();
    for (const f of facts.filter(isActiveSession)) {
      const key = `${f.weekday}|${f.scheduleTime}`;
      const list = slotMap.get(key) ?? [];
      list.push(f);
      slotMap.set(key, list);
    }
    const bySlot = [...slotMap.values()]
      .map((list) => ({
        weekday: list[0]!.weekday,
        scheduleTime: list[0]!.scheduleTime,
        sessions: list.length,
        activeSessions: list.length,
        avgAttendance: round1(list.reduce((s, x) => s + x.attendances, 0) / list.length),
        avgBookings: round1(
          list.reduce((s, x) => s + x.confirmedBookings, 0) / list.length,
        ),
        sampleInsufficient: list.length < CLASS_TIME_COMPARE_MIN_SESSIONS,
      }))
      .sort((a, b) => (b.avgAttendance ?? -1) - (a.avgAttendance ?? -1));

    // For insight, also include scheduled (not only active) counts by using active averages
    const insight = buildClassTimeInsight({
      className: row.className,
      slots: bySlot,
    });

    const recentSessions = [...facts]
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
      .slice(0, 20)
      .map((f) => ({
        scheduledClassId: f.scheduledClassId,
        startsAt: f.startsAt.toISOString(),
        weekday: f.weekday,
        scheduleTime: f.scheduleTime,
        capacity: f.capacity,
        bookings: f.confirmedBookings,
        attendances: f.attendances,
        isActive: isActiveSession(f),
        isEmpty: isEmptySession(f),
        confirmedAttended: f.confirmedAttended,
        missedReservations: Math.max(0, f.confirmedBookings - f.confirmedAttended),
      }));

    return {
      ...row,
      bySlot,
      recentSessions,
      insight: insight?.insight ?? null,
      insightEvidence: insight?.evidence ?? null,
    };
  }
}
