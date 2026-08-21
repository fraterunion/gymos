import {
  classifyMemberEngagement,
  combineEngagementStatus,
  classifyActivityLevel,
  computePersonalTrendPct,
  isRequiresAttentionCandidate,
} from './member-engagement.utils';
import {
  computeConsecutiveActiveWeekStreak,
  formatClassScheduleTimeLocal,
  getClassScheduleWeekdayLocal,
  getStudioLocalWeekStartKey,
} from './member-analytics-schedule.utils';
import { addDaysToDateKey } from '../common/date/studio-local-date';
import { memberAnalyticsPeriodWindows } from './member-analytics-range.utils';

describe('member-analytics schedule semantics', () => {
  const TZ = 'America/Mexico_City';

  it('formats class schedule time from startsAt, not check-in drift', () => {
    const classStart = new Date('2026-08-18T13:00:00.000Z'); // 07:00 CDMX
    const checkIn = new Date('2026-08-18T13:03:00.000Z');
    expect(formatClassScheduleTimeLocal(classStart, TZ)).toBe('07:00');
    expect(formatClassScheduleTimeLocal(checkIn, TZ)).toBe('07:03');
  });

  it('derives weekday from class startsAt in studio timezone', () => {
    const mondayClass = new Date('2026-08-18T13:00:00.000Z'); // Tuesday 07:00 CDMX
    expect(getClassScheduleWeekdayLocal(mondayClass, TZ)).toBe(2);
  });

  it('computes consecutive active-week streak in studio-local weeks', () => {
    const now = new Date('2026-08-21T18:00:00.000Z');
    const w0 = getStudioLocalWeekStartKey(now, TZ);
    const w1 = addDaysToDateKey(w0, -7);
    const w2 = addDaysToDateKey(w0, -14);
    expect(computeConsecutiveActiveWeekStreak([w0, w1, w2], now, TZ)).toBe(3);
    expect(computeConsecutiveActiveWeekStreak([w1, w2], now, TZ)).toBe(2);
  });
});

describe('member engagement health vs activity', () => {
  it('personal decline overrides absolute frequency bucket', () => {
    const result = classifyMemberEngagement({
      visitsLast30d: 4,
      visitsPrior30d: 12,
      daysSinceLastVisit: 5,
      activeWeeksLast90d: 3,
      isEntitled: true,
    });
    expect(result.activityLevel).toBe('ACTIVE');
    expect(result.health).toBe('AT_RISK');
    expect(result.status).toBe('AT_RISK');
    expect(result.reasons.some((r) => r.includes('↓'))).toBe(true);
  });

  it('stable low-frequency mild decline is observation, not at-risk', () => {
    const result = classifyMemberEngagement({
      visitsLast30d: 3,
      visitsPrior30d: 4,
      daysSinceLastVisit: 3,
      activeWeeksLast90d: 2,
      isEntitled: true,
    });
    expect(result.health).toBe('WATCH');
    expect(result.status).toBe('LOW_ACTIVITY');
  });

  it('excludes lapsed members from requires-attention candidates', () => {
    const result = classifyMemberEngagement({
      visitsLast30d: 0,
      visitsPrior30d: 10,
      daysSinceLastVisit: 60,
      activeWeeksLast90d: 0,
      isEntitled: false,
    });
    expect(isRequiresAttentionCandidate(result, false)).toBe(false);
    expect(result.reasons).toContain('Membresía no activa');
  });

  it('includes entitled inactive members in requires-attention candidates', () => {
    const result = classifyMemberEngagement({
      visitsLast30d: 0,
      visitsPrior30d: 0,
      daysSinceLastVisit: 20,
      activeWeeksLast90d: 0,
      isEntitled: true,
    });
    expect(isRequiresAttentionCandidate(result, true)).toBe(true);
    expect(result.health).toBe('AT_RISK');
  });

  it('uses deterministic trend baseline threshold', () => {
    expect(computePersonalTrendPct(4, 3)).toBeNull();
    expect(computePersonalTrendPct(4, 12)).toBe(-67);
  });
});

describe('member-analytics-range timezone boundaries', () => {
  it('uses Mexico City month boundary', () => {
    const w = memberAnalyticsPeriodWindows(new Date('2026-08-21T18:00:00.000Z'), 'America/Mexico_City', 'this_month');
    expect(w.periodStart.toISOString()).toBe('2026-08-01T06:00:00.000Z');
  });
});

describe('engagement combine semantics', () => {
  it('maps healthy very active activity to UI status', () => {
    expect(combineEngagementStatus('HEALTHY', classifyActivityLevel(10), true)).toBe('VERY_ACTIVE');
  });
});
