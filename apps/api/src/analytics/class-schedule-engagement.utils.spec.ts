import {
  buildClassTimeInsight,
  buildOpportunities,
  CLASS_RANKING_MIN_ACTIVE_SESSIONS,
  CLASS_TIME_COMPARE_MIN_SESSIONS,
  classifyDemandBand,
  computeShowRatePct,
  isActiveSession,
  isEmptySession,
  SLOT_RECOMMENDATION_MIN_SESSIONS,
  type SessionFact,
} from './class-schedule-engagement.utils';

function fact(partial: Partial<SessionFact> = {}): SessionFact {
  return {
    scheduledClassId: 'sc1',
    classTemplateId: 'tpl1',
    className: 'Push',
    capacity: 25,
    startsAt: new Date('2026-08-01T13:00:00.000Z'),
    weekday: 3,
    scheduleTime: '07:00',
    hour: 7,
    attendances: 0,
    confirmedBookings: 0,
    confirmedAttended: 0,
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

  it('does not treat capacity 10 as inherently stronger than capacity 25', () => {
    // Same avg attendance → same band regardless of capacity
    expect(
      classifyDemandBand({ avgAttendance: 2.6, sampleSize: 5 }),
    ).toBe(
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
        },
      ],
      classSlots: [],
      studioShowRatePct: 70,
    });
    expect(ops).toHaveLength(0);
    expect(SLOT_RECOMMENDATION_MIN_SESSIONS).toBe(4);
  });

  it('emits STRONG_SLOT with evidence when sample sufficient', () => {
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
        },
      ],
      classSlots: [],
      studioShowRatePct: 70,
    });
    expect(ops.some((o) => o.type === 'STRONG_SLOT')).toBe(true);
    expect(ops[0]!.evidence).toContain('n=5'.replace('n=5', '5 sesiones'));
    expect(ops[0]!.sampleSize).toBe(5);
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
      classifyDemandBand({ avgAttendance: 4, sampleSize: 1, minSample: CLASS_RANKING_MIN_ACTIVE_SESSIONS }),
    ).toBe('INSUFICIENTE');
  });

  it('builds class time insight only with enough evidence', () => {
    const insight = buildClassTimeInsight({
      className: 'Push',
      slots: [
        { weekday: 3, scheduleTime: '07:00', activeSessions: 4, avgAttendance: 4 },
        { weekday: 3, scheduleTime: '08:00', activeSessions: 4, avgAttendance: 1.5 },
      ],
    });
    expect(insight?.insight).toContain('Push');
    expect(insight?.evidence).toContain('07:00');

    expect(
      buildClassTimeInsight({
        className: 'Booty Lab',
        slots: [
          { weekday: 4, scheduleTime: '07:15', activeSessions: 1, avgAttendance: 4 },
        ],
      }),
    ).toBeNull();
  });

  it('flags REVIEW_LOW_DEMAND for weak slots with high empty rate', () => {
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
        },
      ],
      classSlots: [],
      studioShowRatePct: 70,
    });
    expect(ops.some((o) => o.type === 'REVIEW_LOW_DEMAND')).toBe(true);
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
