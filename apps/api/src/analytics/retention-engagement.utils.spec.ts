import {
  assessRecovered,
  buildMemberPatternSentence,
  classifyMovement,
  classifyPriorWindowHealth,
  classifyRetentionMember,
  RETENTION_ACTION_LABELS,
  suggestRetentionAction,
  toRetentionHealth,
  CLASS_STICKINESS_MIN_SAMPLE,
  COHORT_MIN_SIZE,
  isRequiresActionRow,
  retentionActionPriority,
} from './retention-engagement.utils';
import { classifyMemberEngagement } from './member-engagement.utils';

describe('retention-engagement.utils', () => {
  const base = {
    visits60to90d: 0,
    daysSinceLastVisitAtPriorEnd: null as number | null,
    gapDaysBeforeReturn: null as number | null,
    visitsSinceReturn: null as number | null,
    activeWeeksLast90d: 4,
    isEntitled: true,
  };

  it('keeps stable high-frequency member healthy and estable', () => {
    const r = classifyRetentionMember({
      ...base,
      visitsLast30d: 10,
      visitsPrior30d: 10,
      daysSinceLastVisit: 2,
      visits60to90d: 10,
      daysSinceLastVisitAtPriorEnd: 1,
    });
    expect(r.retentionHealth).toBe('HEALTHY');
    expect(r.movement).toBe('ESTABLE');
    expect(r.recovered.isRecovered).toBe(false);
  });

  it('flags declining high-frequency as at-risk with reason', () => {
    const r = classifyRetentionMember({
      ...base,
      visitsLast30d: 4,
      visitsPrior30d: 12,
      daysSinceLastVisit: 3,
      visits60to90d: 12,
      daysSinceLastVisitAtPriorEnd: 2,
    });
    expect(r.retentionHealth).toBe('AT_RISK');
    expect(r.engagement.reasons.some((x) => x.includes('↓'))).toBe(true);
    expect(r.movement).toBe('EN_RIESGO');
  });

  it('does not force decline risk on stable low-frequency without baseline', () => {
    const r = classifyRetentionMember({
      ...base,
      visitsLast30d: 2,
      visitsPrior30d: 2,
      daysSinceLastVisit: 4,
      visits60to90d: 1,
      daysSinceLastVisitAtPriorEnd: 5,
    });
    expect(r.retentionHealth).not.toBe('AT_RISK');
    expect(r.trendPct).toBeNull();
  });

  it('classifies recency-based at risk', () => {
    const r = classifyRetentionMember({
      ...base,
      visitsLast30d: 3,
      visitsPrior30d: 3,
      daysSinceLastVisit: 16,
      visits60to90d: 3,
      daysSinceLastVisitAtPriorEnd: 2,
    });
    expect(r.retentionHealth).toBe('AT_RISK');
    expect(r.engagement.reasons[0]).toContain('16 días');
  });

  it('marks entitled inactive without visits', () => {
    const r = classifyRetentionMember({
      ...base,
      visitsLast30d: 0,
      visitsPrior30d: 0,
      daysSinceLastVisit: null,
      visits60to90d: 0,
      daysSinceLastVisitAtPriorEnd: null,
    });
    expect(r.retentionHealth).toBe('INACTIVE');
    expect(r.movement).toBe('SIN_ACTIVIDAD');
  });

  it('excludes lapsed from risk health', () => {
    const r = classifyRetentionMember({
      ...base,
      isEntitled: false,
      visitsLast30d: 0,
      visitsPrior30d: 8,
      daysSinceLastVisit: 40,
    });
    expect(r.retentionHealth).toBe('LAPSED');
    expect(r.movement).toBe('MEMBRESIA_FINALIZADA');
    expect(r.engagement.health).toBe('INACTIVE');
  });

  it('detects recovered after gap with meaningful return', () => {
    const recovered = assessRecovered({
      isEntitled: true,
      visits30d: 3,
      daysSinceLastVisit: 2,
      priorHealth: 'INACTIVE',
      gapDaysBeforeReturn: 23,
      visitsSinceReturn: 3,
      currentHealth: 'HEALTHY',
    });
    expect(recovered.isRecovered).toBe(true);
    expect(recovered.reasons.some((r) => r.includes('23'))).toBe(true);
  });

  it('prevents false recovery on single visit bounce', () => {
    const recovered = assessRecovered({
      isEntitled: true,
      visits30d: 1,
      daysSinceLastVisit: 1,
      priorHealth: 'AT_RISK',
      gapDaysBeforeReturn: 20,
      visitsSinceReturn: 1,
      currentHealth: 'HEALTHY',
    });
    expect(recovered.isRecovered).toBe(false);
  });

  it('classifies movement improving / declining / stable', () => {
    expect(
      classifyMovement({
        isEntitled: true,
        isRecovered: false,
        currentHealth: 'HEALTHY',
        priorHealth: 'AT_RISK',
        trendPct: 10,
      }),
    ).toBe('MEJORANDO');
    expect(
      classifyMovement({
        isEntitled: true,
        isRecovered: false,
        currentHealth: 'WATCH',
        priorHealth: 'HEALTHY',
        trendPct: -25,
      }),
    ).toBe('BAJANDO');
    expect(
      classifyMovement({
        isEntitled: true,
        isRecovered: false,
        currentHealth: 'HEALTHY',
        priorHealth: 'HEALTHY',
        trendPct: 0,
      }),
    ).toBe('ESTABLE');
  });

  it('suggests deterministic actions', () => {
    expect(
      suggestRetentionAction({
        isEntitled: true,
        isRecovered: true,
        health: 'HEALTHY',
        movement: 'RECUPERADO',
        daysSinceLastVisit: 2,
        entitlementEndsAt: null,
        now: new Date(),
      }),
    ).toBe('FELICITAR_REGRESO');
    expect(
      suggestRetentionAction({
        isEntitled: true,
        isRecovered: false,
        health: 'INACTIVE',
        movement: 'SIN_ACTIVIDAD',
        daysSinceLastVisit: 40,
        entitlementEndsAt: null,
        now: new Date(),
      }),
    ).toBe('CONTACTAR');
    expect(RETENTION_ACTION_LABELS.CONTACTAR).toBe('Contactar');
  });

  it('builds pattern sentence deterministically with enough evidence', () => {
    const sentence = buildMemberPatternSentence({
      favoriteWeekdays: [1, 3],
      favoriteTime: '07:00',
      daysSinceLastVisit: 16,
      visits30d: 4,
      visitsPrior30d: 11,
      trendPct: -64,
      preferenceEvidenceCount: 5,
    });
    expect(sentence).toContain('Normalmente entrena lunes y miércoles');
    expect(sentence).toContain('07:00');
    expect(sentence).toContain('11 a 4');
    expect(sentence).toContain('16 días');
  });

  it('does not say normalmente with low preference evidence', () => {
    const sentence = buildMemberPatternSentence({
      favoriteWeekdays: [1],
      favoriteTime: '07:00',
      daysSinceLastVisit: 2,
      visits30d: 1,
      visitsPrior30d: 0,
      trendPct: null,
      preferenceEvidenceCount: 1,
    });
    expect(sentence).not.toContain('Normalmente');
    expect(sentence).toContain('Horario más frecuente: 07:00');
  });

  it('uses SIN_BASELINE when prior windows are empty', () => {
    expect(
      classifyMovement({
        isEntitled: true,
        isRecovered: false,
        currentHealth: 'HEALTHY',
        priorHealth: 'INACTIVE',
        trendPct: null,
        insufficientPriorHistory: true,
      }),
    ).toBe('SIN_BASELINE');
  });

  it('ranks recovered below inactive and at-risk', () => {
    const recovered = retentionActionPriority({
      health: 'HEALTHY',
      daysSinceLastVisit: 1,
      trendPct: null,
      isRecovered: true,
    });
    const inactive = retentionActionPriority({
      health: 'INACTIVE',
      daysSinceLastVisit: 40,
      trendPct: null,
      isRecovered: false,
    });
    const atRisk = retentionActionPriority({
      health: 'AT_RISK',
      daysSinceLastVisit: 16,
      trendPct: null,
      isRecovered: false,
    });
    expect(inactive).toBeGreaterThan(atRisk);
    expect(atRisk).toBeGreaterThan(recovered);
  });

  it('maps observation health from WATCH', () => {
    const engagement = classifyMemberEngagement({
      visitsLast30d: 5,
      visitsPrior30d: 5,
      daysSinceLastVisit: 10,
      activeWeeksLast90d: 3,
      isEntitled: true,
    });
    expect(engagement.health).toBe('WATCH');
    expect(toRetentionHealth(engagement, true)).toBe('OBSERVATION');
  });

  it('prioritizes inactive above observation for action list', () => {
    expect(
      retentionActionPriority({
        health: 'INACTIVE',
        daysSinceLastVisit: 35,
        trendPct: null,
        isRecovered: false,
      }),
    ).toBeGreaterThan(
      retentionActionPriority({
        health: 'OBSERVATION',
        daysSinceLastVisit: 8,
        trendPct: -25,
        isRecovered: false,
      }),
    );
  });

  it('requires-action only for entitled risk/inactive/recovered', () => {
    expect(isRequiresActionRow({ isEntitled: true, health: 'AT_RISK', isRecovered: false })).toBe(
      true,
    );
    expect(
      isRequiresActionRow({ isEntitled: true, health: 'OBSERVATION', isRecovered: false }),
    ).toBe(false);
    expect(isRequiresActionRow({ isEntitled: false, health: 'LAPSED', isRecovered: false })).toBe(
      false,
    );
  });

  it('exports sample thresholds', () => {
    expect(CLASS_STICKINESS_MIN_SAMPLE).toBe(5);
    expect(COHORT_MIN_SIZE).toBe(10);
  });

  it('classifies prior window health independently', () => {
    expect(
      classifyPriorWindowHealth({
        visitsPrior30d: 0,
        visits60to90d: 8,
        daysSinceLastVisitAtPriorEnd: 35,
        isEntitled: true,
      }),
    ).toBe('INACTIVE');
  });
});
