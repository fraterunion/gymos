import {
  classifyMemberEngagement,
  computePersonalTrendPct,
  computeVisitsPerWeek,
  frequencyBucket,
  isRequiresAttentionCandidate,
} from './member-engagement.utils';
import {
  memberAnalyticsPeriodWindows,
  rollingWindowStart,
} from './member-analytics-range.utils';

describe('member-engagement.utils', () => {
  it('computes personal trend only with sufficient baseline', () => {
    expect(computePersonalTrendPct(4, 12)).toBe(-67);
    expect(computePersonalTrendPct(4, 3)).toBeNull();
  });

  it('classifies at-risk on recency and personal decline', () => {
    const decline = classifyMemberEngagement({
      visitsLast30d: 4,
      visitsPrior30d: 12,
      daysSinceLastVisit: 5,
      activeWeeksLast90d: 3,
      isEntitled: true,
    });
    expect(decline.status).toBe('AT_RISK');
    expect(decline.reasons.some((r) => r.includes('↓'))).toBe(true);

    const recency = classifyMemberEngagement({
      visitsLast30d: 2,
      visitsPrior30d: 2,
      daysSinceLastVisit: 15,
      activeWeeksLast90d: 1,
      isEntitled: true,
    });
    expect(recency.status).toBe('AT_RISK');
  });

  it('does not treat small personal changes as at-risk', () => {
    const stable = classifyMemberEngagement({
      visitsLast30d: 3,
      visitsPrior30d: 4,
      daysSinceLastVisit: 3,
      activeWeeksLast90d: 2,
      isEntitled: true,
    });
    expect(stable.status).not.toBe('AT_RISK');
  });

  it('marks entitled inactive without visits', () => {
    const result = classifyMemberEngagement({
      visitsLast30d: 0,
      visitsPrior30d: 0,
      daysSinceLastVisit: null,
      activeWeeksLast90d: 0,
      isEntitled: true,
    });
    expect(result.status).toBe('INACTIVE');
    expect(isRequiresAttentionCandidate(result, true)).toBe(true);
  });

  it('maps frequency buckets', () => {
    expect(frequencyBucket(0)).toBe('0');
    expect(frequencyBucket(16)).toBe('16+');
  });

  it('computes visits per week', () => {
    expect(computeVisitsPerWeek(10, 30)).toBe(2.3);
  });
});

describe('member-analytics-range.utils', () => {
  const TZ = 'America/Mexico_City';
  const NOW = new Date('2026-08-21T18:00:00.000Z');

  it('uses studio-local month boundaries for this_month', () => {
    const w = memberAnalyticsPeriodWindows(NOW, TZ, 'this_month');
    expect(w.period).toBe('this_month');
    expect(w.isPartialPeriod).toBe(true);
    expect(w.periodStart.toISOString()).toBe('2026-08-01T06:00:00.000Z');
  });

  it('builds rolling 30-day window in studio timezone', () => {
    const start = rollingWindowStart(NOW, TZ, 30);
    expect(start.toISOString()).toBe('2026-07-23T06:00:00.000Z');
  });
});
