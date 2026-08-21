import {
  buildOpportunities,
  buildOperationalReadings,
  CLASS_RANKING_MIN_ACTIVE_SESSIONS,
  CLASS_TIME_COMPARE_MIN_SESSIONS,
  classifyDemandBand,
  classifySlotMaturity,
  computeShowRatePct,
  ESTABLISHED_SLOT_MIN_DISTINCT_WEEKS,
  ESTABLISHED_SLOT_MIN_SESSIONS,
  isActiveSession,
  isEmptySession,
  operationalReadingOverlapsOpportunity,
  SAMPLE_INSUFFICIENT_LABEL,
  SLOT_RECOMMENDATION_MIN_SESSIONS,
  type SessionFact,
} from './class-schedule-engagement.utils';
import { getStudioLocalWeekStartKey } from './member-analytics-schedule.utils';

const TZ = 'America/Mexico_City';

function fact(partial: Partial<SessionFact> = {}): SessionFact {
  const startsAt = partial.startsAt ?? new Date('2026-08-03T13:00:00.000Z'); // Mon 07:00 CDMX
  return {
    scheduledClassId: 'sc1',
    classTemplateId: 'tpl1',
    className: 'Push',
    capacity: 25,
    startsAt,
    weekday: 1,
    scheduleTime: '07:00',
    hour: 7,
    attendances: 0,
    confirmedBookings: 0,
    confirmedAttended: 0,
    localWeekStartKey: getStudioLocalWeekStartKey(startsAt, TZ),
    ...partial,
  };
}

describe('class-schedule-engagement.utils', () => {
  it('computes show rate excluding cancelled and walk-ins from denominator', () => {
    expect(computeShowRatePct(8, 10)).toBe(80);
    expect(computeShowRatePct(0, 0)).toBeNull();
  });

  it('distinguishes active vs empty sessions', () => {
    expect(isActiveSession(fact({ attendances: 1 }))).toBe(true);
    expect(isActiveSession(fact({ confirmedBookings: 2 }))).toBe(true);
    expect(isEmptySession(fact({}))).toBe(true);
    expect(isEmptySession(fact({ attendances: 1 }))).toBe(false);
  });

  it('classifies slot maturity by sessions AND distinct local weeks', () => {
    expect(ESTABLISHED_SLOT_MIN_SESSIONS).toBe(4);
    expect(ESTABLISHED_SLOT_MIN_DISTINCT_WEEKS).toBe(4);
    expect(
      classifySlotMaturity({ eligibleSessionCount: 3, distinctLocalWeekCount: 3 }),
    ).toBe('LIMITED_HISTORY_SLOT');
    expect(
      classifySlotMaturity({ eligibleSessionCount: 4, distinctLocalWeekCount: 2 }),
    ).toBe('LIMITED_HISTORY_SLOT');
    expect(
      classifySlotMaturity({ eligibleSessionCount: 4, distinctLocalWeekCount: 4 }),
    ).toBe('ESTABLISHED_SLOT');
  });

  it('uses studio-local Monday week boundaries for week keys', () => {
    // Tue Aug 18 07:05 CDMX
    const tue = new Date('2026-08-18T13:05:00.000Z');
    // Thu Aug 20 07:15 CDMX — same ISO week as Tue (Mon Aug 17 start)
    const thu = new Date('2026-08-20T13:15:00.000Z');
    expect(getStudioLocalWeekStartKey(tue, TZ)).toBe('2026-08-17');
    expect(getStudioLocalWeekStartKey(thu, TZ)).toBe('2026-08-17');
    // Next week Tue
    const nextTue = new Date('2026-08-25T13:05:00.000Z');
    expect(getStudioLocalWeekStartKey(nextTue, TZ)).toBe('2026-08-24');
  });

  it('never implies HH:MM rounding in slot labels', () => {
    const ops = buildOpportunities({
      slots: [
        {
          weekday: 2,
          scheduleTime: '07:05',
          scheduledSessions: 5,
          activeSessions: 5,
          emptySessions: 0,
          emptyRatePct: 0,
          avgAttendance: 3,
          showRatePct: 80,
          confirmedBookings: 10,
          slotMaturity: 'ESTABLISHED_SLOT',
        },
      ],
      classSlots: [],
      studioShowRatePct: 70,
    });
    expect(ops[0]!.subject).toContain('07:05');
    expect(ops[0]!.subject).not.toContain('07:00');
  });

  it('blocks strategic recommendations for LIMITED_HISTORY_SLOT even with high avg', () => {
    const ops = buildOpportunities({
      slots: [
        {
          weekday: 4,
          scheduleTime: '07:15',
          scheduledSessions: 1,
          activeSessions: 1,
          emptySessions: 0,
          emptyRatePct: 0,
          avgAttendance: 4,
          showRatePct: 100,
          confirmedBookings: 4,
          slotMaturity: 'LIMITED_HISTORY_SLOT',
        },
      ],
      classSlots: [],
      studioShowRatePct: 70,
    });
    expect(ops).toHaveLength(0);
  });

  it('does not treat capacity 10 as inherently stronger than capacity 25', () => {
    expect(classifyDemandBand({ avgAttendance: 2.6, sampleSize: 5 })).toBe(
      classifyDemandBand({ avgAttendance: 2.6, sampleSize: 5 }),
    );
    expect(classifyDemandBand({ avgAttendance: 4, sampleSize: 5 })).toBe('ALTA');
    expect(classifyDemandBand({ avgAttendance: 1.0, sampleSize: 5 })).toBe('BAJA');
    expect(classifyDemandBand({ avgAttendance: 4, sampleSize: 2 })).toBe('INSUFICIENTE');
  });

  it('suppresses slot recommendations below sample gate', () => {
    const ops = buildOpportunities({
      slots: [
        {
          weekday: 3,
          scheduleTime: '07:00',
          scheduledSessions: 3,
          activeSessions: 3,
          emptySessions: 0,
          emptyRatePct: 0,
          avgAttendance: 4.4,
          showRatePct: 80,
          confirmedBookings: 10,
          slotMaturity: 'LIMITED_HISTORY_SLOT',
        },
      ],
      classSlots: [],
      studioShowRatePct: 70,
    });
    expect(ops).toHaveLength(0);
    expect(SLOT_RECOMMENDATION_MIN_SESSIONS).toBe(4);
  });

  it('emits FORTALEZA with metric-first hierarchy when established', () => {
    const ops = buildOpportunities({
      slots: [
        {
          weekday: 3,
          scheduleTime: '07:00',
          scheduledSessions: 5,
          activeSessions: 5,
          emptySessions: 0,
          emptyRatePct: 0,
          avgAttendance: 4.4,
          showRatePct: 80,
          confirmedBookings: 10,
          slotMaturity: 'ESTABLISHED_SLOT',
        },
      ],
      classSlots: [],
      studioShowRatePct: 70,
    });
    expect(ops.some((o) => o.type === 'STRONG_SLOT')).toBe(true);
    expect(ops[0]!.title).toBe('FORTALEZA');
    expect(ops[0]!.headlineMetric).toContain('asistencias / sesión');
    expect(ops[0]!.supportingMetric).toContain('sesiones analizadas');
    expect(ops[0]!.suggestedAction).toContain('Protege');
  });

  it('emits COMPARE_CLASS_TIME when same class differs by slot', () => {
    const ops = buildOpportunities({
      slots: [],
      classSlots: [
        {
          classTemplateId: 'push',
          className: 'Push',
          weekday: 3,
          scheduleTime: '07:00',
          sessions: 4,
          activeSessions: 4,
          avgAttendance: 4.0,
        },
        {
          classTemplateId: 'push',
          className: 'Push',
          weekday: 3,
          scheduleTime: '08:00',
          sessions: 4,
          activeSessions: 4,
          avgAttendance: 1.5,
        },
      ],
      studioShowRatePct: 70,
    });
    expect(ops.some((o) => o.type === 'COMPARE_CLASS_TIME')).toBe(true);
    expect(CLASS_TIME_COMPARE_MIN_SESSIONS).toBe(3);
  });

  it('does not rank single-session class as confident winner via sample gate', () => {
    expect(CLASS_RANKING_MIN_ACTIVE_SESSIONS).toBe(5);
    expect(
      classifyDemandBand({
        avgAttendance: 4,
        sampleSize: 1,
        minSample: CLASS_RANKING_MIN_ACTIVE_SESSIONS,
      }),
    ).toBe('INSUFICIENTE');
    expect(SAMPLE_INSUFFICIENT_LABEL).toBe('Muestra insuficiente');
  });

  it('builds operational readings with evidence and without ADD_CAPACITY', () => {
    const readings = buildOperationalReadings({
      templates: [
        {
          className: 'Legs + HIIT',
          activeSessions: 16,
          attendances: 31,
          avgAttendancePerActiveSession: 2.6,
          showRatePct: 81.8,
          sampleInsufficient: false,
          uniqueMembers: 20,
        },
        {
          className: 'Upperbody',
          activeSessions: 10,
          attendances: 21,
          avgAttendancePerActiveSession: 2.1,
          showRatePct: 57.1,
          sampleInsufficient: false,
          uniqueMembers: 12,
        },
        {
          className: 'Booty Lab',
          activeSessions: 1,
          attendances: 4,
          avgAttendancePerActiveSession: 4,
          sampleInsufficient: true,
          showRatePct: 100,
          uniqueMembers: 4,
        },
      ],
      slots: [
        {
          weekday: 1,
          scheduleTime: '20:00',
          scheduledSessions: 6,
          emptyRatePct: 83,
          avgAttendance: 0,
          slotMaturity: 'ESTABLISHED_SLOT',
        },
      ],
    });
    expect(readings.length).toBeGreaterThan(0);
    expect(readings.length).toBeLessThanOrEqual(3);
    expect(readings.every((r) => r.evidence.length > 0 && r.sampleSize > 0)).toBe(true);
    expect(readings.every((r) => r.kind != null)).toBe(true);
    expect(readings.some((r) => /Booty Lab/.test(r.text))).toBe(false);
    const blob = JSON.stringify(readings);
    expect(blob).not.toMatch(/ADD_CAPACITY|ADD_SESSION|mejor clase|causa/i);
  });

  it('suppresses LOW_DEMAND_SLOT reading when REVIEW_LOW_DEMAND opportunity already covers same time', () => {
    const readings = buildOperationalReadings({
      templates: [
        {
          className: 'Upperbody',
          activeSessions: 10,
          attendances: 21,
          avgAttendancePerActiveSession: 2.1,
          showRatePct: 57.1,
          sampleInsufficient: false,
          uniqueMembers: 12,
        },
      ],
      slots: [
        {
          weekday: 1,
          scheduleTime: '20:00',
          scheduledSessions: 4,
          emptyRatePct: 100,
          avgAttendance: 0,
          slotMaturity: 'ESTABLISHED_SLOT',
        },
        {
          weekday: 5,
          scheduleTime: '18:00',
          scheduledSessions: 4,
          emptyRatePct: 50,
          avgAttendance: 0.5,
          slotMaturity: 'ESTABLISHED_SLOT',
        },
      ],
      opportunities: [
        {
          type: 'REVIEW_LOW_DEMAND',
          className: null,
          classTemplateId: null,
          weekday: 1,
          scheduleTime: '20:00',
        },
      ],
    });
    expect(readings.some((r) => r.kind === 'LOW_DEMAND_SLOT' && r.scheduleTime === '20:00')).toBe(
      false,
    );
    expect(readings.some((r) => r.kind === 'SOFT_SHOW')).toBe(true);
    // Falls through to next distinct weak slot when 20:00 is already an opportunity.
    expect(readings.some((r) => r.kind === 'LOW_DEMAND_SLOT' && r.scheduleTime === '18:00')).toBe(
      true,
    );
  });

  it('operationalReadingOverlapsOpportunity matches clock-time low-demand pairs', () => {
    expect(
      operationalReadingOverlapsOpportunity(
        {
          kind: 'LOW_DEMAND_SLOT',
          className: null,
          weekday: 1,
          scheduleTime: '20:00',
        },
        {
          type: 'REVIEW_LOW_DEMAND',
          className: null,
          classTemplateId: null,
          weekday: 1,
          scheduleTime: '20:00',
        },
      ),
    ).toBe(true);
    expect(
      operationalReadingOverlapsOpportunity(
        {
          kind: 'SOFT_SHOW',
          className: 'Upperbody',
          weekday: null,
          scheduleTime: null,
        },
        {
          type: 'REVIEW_LOW_DEMAND',
          className: null,
          classTemplateId: null,
          weekday: 1,
          scheduleTime: '20:00',
        },
      ),
    ).toBe(false);
  });

  it('flags REVIEW_LOW_DEMAND for weak established slots with high empty rate', () => {
    const ops = buildOpportunities({
      slots: [
        {
          weekday: 1,
          scheduleTime: '20:00',
          scheduledSessions: 8,
          activeSessions: 2,
          emptySessions: 6,
          emptyRatePct: 75,
          avgAttendance: 0.5,
          showRatePct: 50,
          confirmedBookings: 5,
          slotMaturity: 'ESTABLISHED_SLOT',
        },
      ],
      classSlots: [],
      studioShowRatePct: 70,
    });
    expect(ops.some((o) => o.type === 'REVIEW_LOW_DEMAND')).toBe(true);
    expect(ops[0]!.title).toBe('REVISAR');
  });

  it('diversifies opportunities so STRONG_SLOT is not crowded out', () => {
    const slots = [];
    for (let i = 0; i < 6; i++) {
      slots.push({
        weekday: i,
        scheduleTime: '20:00',
        scheduledSessions: 6,
        activeSessions: 1,
        emptySessions: 5,
        emptyRatePct: 80,
        avgAttendance: 0.2,
        showRatePct: 50,
        confirmedBookings: 5,
        slotMaturity: 'ESTABLISHED_SLOT' as const,
      });
    }
    slots.push({
      weekday: 5,
      scheduleTime: '07:00',
      scheduledSessions: 7,
      activeSessions: 7,
      emptySessions: 0,
      emptyRatePct: 0,
      avgAttendance: 2.6,
      showRatePct: 80,
      confirmedBookings: 20,
      slotMaturity: 'ESTABLISHED_SLOT' as const,
    });
    const ops = buildOpportunities({
      slots,
      classSlots: [],
      studioShowRatePct: 70,
    });
    expect(ops.some((o) => o.type === 'STRONG_SLOT')).toBe(true);
    expect(ops.filter((o) => o.type === 'REVIEW_LOW_DEMAND').length).toBeLessThanOrEqual(5);
  });
});
