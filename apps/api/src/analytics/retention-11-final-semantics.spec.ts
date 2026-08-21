import { studioLocalCalendarDaysBetween } from '../common/date/studio-local-date';
import { classifyMemberEngagement } from './member-engagement.utils';
import {
  assessRecovered,
  buildMemberPatternSentence,
  classifyMovement,
  retentionActionPriority,
} from './retention-engagement.utils';

function formatCohortCell(cell: {
  retained: number;
  cohortSize: number;
  ratePct: number | null;
  suppressed: boolean;
  limitedHistoryCoverage?: boolean;
}): string {
  if (cell.suppressed) return '—';
  const base = `${cell.retained}/${cell.cohortSize}${
    cell.ratePct != null ? ` · ${cell.ratePct}%` : ''
  }`;
  return cell.limitedHistoryCoverage ? `${base}*` : base;
}

/**
 * Presentation/semantic regressions for Analytics 1.1 final hardening.
 * Pure functions only — no DB.
 */
describe('Analytics 1.1 final semantic hardening', () => {
  const TZ = 'America/Mexico_City';

  it('14 studio-local calendar days is the risk boundary', () => {
    const lastVisit = new Date('2026-08-08T05:55:00.000Z'); // 23:55 Aug 7 MX
    const now = new Date('2026-08-21T06:05:00.000Z'); // 00:05 Aug 21 MX
    expect(studioLocalCalendarDaysBetween(lastVisit, now, TZ)).toBe(14);

    const engagement = classifyMemberEngagement({
      visitsLast30d: 2,
      visitsPrior30d: 2,
      daysSinceLastVisit: 14,
      activeWeeksLast90d: 2,
      isEntitled: true,
    });
    expect(engagement.health).toBe('AT_RISK');
  });

  it('elapsed hours <14d but calendar days =14 still at-risk', () => {
    const lastVisit = new Date('2026-08-08T05:55:00.000Z');
    const now = new Date('2026-08-21T06:05:00.000Z');
    const calendar = studioLocalCalendarDaysBetween(lastVisit, now, TZ);
    const wallHours = (now.getTime() - lastVisit.getTime()) / 3_600_000;
    expect(calendar).toBe(14);
    expect(wallHours).toBeLessThan(14 * 24);
    expect(
      classifyMemberEngagement({
        visitsLast30d: 3,
        visitsPrior30d: 3,
        daysSinceLastVisit: calendar,
        activeWeeksLast90d: 3,
        isEntitled: true,
      }).health,
    ).toBe('AT_RISK');
  });

  it('recovered gap uses local calendar days semantics', () => {
    const gap = studioLocalCalendarDaysBetween(
      new Date('2026-07-20T05:55:00.000Z'),
      new Date('2026-08-03T06:05:00.000Z'),
      TZ,
    );
    expect(gap).toBeGreaterThanOrEqual(14);
    expect(
      assessRecovered({
        isEntitled: true,
        visits30d: 2,
        daysSinceLastVisit: 1,
        priorHealth: 'INACTIVE',
        gapDaysBeforeReturn: gap,
        visitsSinceReturn: 2,
        currentHealth: 'HEALTHY',
      }).isRecovered,
    ).toBe(true);
  });

  it('one return visit after long gap is not recovered', () => {
    expect(
      assessRecovered({
        isEntitled: true,
        visits30d: 1,
        daysSinceLastVisit: 1,
        priorHealth: 'INACTIVE',
        gapDaysBeforeReturn: 30,
        visitsSinceReturn: 1,
        currentHealth: 'HEALTHY',
      }).isRecovered,
    ).toBe(false);
  });

  it('cohort cell shows original denominator and M1 may exceed M0', () => {
    const m0 = { retained: 16, cohortSize: 23, ratePct: 70, suppressed: false };
    const m1 = { retained: 17, cohortSize: 23, ratePct: 74, suppressed: false };
    expect(m1.retained).toBeGreaterThan(m0.retained);
    expect(formatCohortCell(m0)).toBe('16/23 · 70%');
    expect(formatCohortCell(m1)).toBe('17/23 · 74%');
  });

  it('partial historical coverage is annotated not suppressed', () => {
    expect(
      formatCohortCell({
        retained: 16,
        cohortSize: 23,
        ratePct: 70,
        suppressed: false,
        limitedHistoryCoverage: true,
      }),
    ).toBe('16/23 · 70%*');
  });

  it('insufficient prior baseline is not labeled Estable', () => {
    expect(
      classifyMovement({
        isEntitled: true,
        isRecovered: false,
        currentHealth: 'HEALTHY',
        priorHealth: 'INACTIVE',
        trendPct: 100,
        insufficientPriorHistory: true,
      }),
    ).toBe('SIN_BASELINE');
  });

  it('recovered ranks below risk for requires-action', () => {
    expect(
      retentionActionPriority({
        health: 'AT_RISK',
        daysSinceLastVisit: 14,
        trendPct: null,
        isRecovered: false,
      }),
    ).toBeGreaterThan(
      retentionActionPriority({
        health: 'HEALTHY',
        daysSinceLastVisit: 1,
        trendPct: null,
        isRecovered: true,
      }),
    );
  });

  it('low-evidence pattern does not say normally', () => {
    const s = buildMemberPatternSentence({
      favoriteWeekdays: [1, 3],
      favoriteTime: '07:00',
      daysSinceLastVisit: 2,
      visits30d: 1,
      visitsPrior30d: 0,
      trendPct: null,
      preferenceEvidenceCount: 2,
    });
    expect(s).not.toMatch(/normalmente/i);
  });
});
