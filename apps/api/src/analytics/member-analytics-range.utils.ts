import {
  addDaysToDateKey,
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
} from '../common/date/studio-local-date';

export type MemberAnalyticsPeriodKey =
  | 'this_month'
  | 'prev_month'
  | 'last_7d'
  | 'last_30d'
  | 'last_90d'
  | 'this_year'
  | 'custom';

export const MEMBER_ANALYTICS_PERIOD_LABELS: Record<MemberAnalyticsPeriodKey, string> = {
  this_month: 'Este mes',
  prev_month: 'Mes anterior',
  last_7d: 'Últimos 7 días',
  last_30d: 'Últimos 30 días',
  last_90d: 'Últimos 90 días',
  this_year: 'Este año',
  custom: 'Personalizado',
};

export type MemberAnalyticsPeriodWindows = {
  period: MemberAnalyticsPeriodKey;
  timezone: string;
  periodStart: Date;
  periodEnd: Date;
  /** Comparable immediately preceding period of equal duration. */
  prevPeriodStart: Date;
  prevPeriodEnd: Date;
  isPartialPeriod: boolean;
};

function monthBoundsFromKey(monthKey: string, timezone: string) {
  const [yearStr, monthStr] = monthKey.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const startKey = `${yearStr}-${monthStr}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endExclusiveKey = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
  return {
    periodStart: studioLocalDateKeyToUtcAnchor(startKey, timezone),
    periodEndExclusive: studioLocalDateKeyToUtcAnchor(endExclusiveKey, timezone),
  };
}

export function memberAnalyticsPeriodWindows(
  now: Date,
  timezone: string,
  period: MemberAnalyticsPeriodKey,
  customFrom?: string,
  customTo?: string,
): MemberAnalyticsPeriodWindows {
  const nowKey = getStudioLocalDateKey(now, timezone);

  if (period === 'last_7d') {
    const startKey = addDaysToDateKey(nowKey, -6);
    const periodStart = studioLocalDateKeyToUtcAnchor(startKey, timezone);
    const prevEnd = new Date(periodStart.getTime() - 1);
    const prevStartKey = addDaysToDateKey(startKey, -7);
    return {
      period,
      timezone,
      periodStart,
      periodEnd: now,
      prevPeriodStart: studioLocalDateKeyToUtcAnchor(prevStartKey, timezone),
      prevPeriodEnd: prevEnd,
      isPartialPeriod: false,
    };
  }

  if (period === 'last_30d') {
    const startKey = addDaysToDateKey(nowKey, -29);
    const periodStart = studioLocalDateKeyToUtcAnchor(startKey, timezone);
    const prevEnd = new Date(periodStart.getTime() - 1);
    const prevStartKey = addDaysToDateKey(startKey, -30);
    const prevPeriodStart = studioLocalDateKeyToUtcAnchor(prevStartKey, timezone);
    return {
      period,
      timezone,
      periodStart,
      periodEnd: now,
      prevPeriodStart,
      prevPeriodEnd: prevEnd,
      isPartialPeriod: false,
    };
  }

  if (period === 'last_90d') {
    const startKey = addDaysToDateKey(nowKey, -89);
    const periodStart = studioLocalDateKeyToUtcAnchor(startKey, timezone);
    const prevEnd = new Date(periodStart.getTime() - 1);
    const prevStartKey = addDaysToDateKey(startKey, -90);
    return {
      period,
      timezone,
      periodStart,
      periodEnd: now,
      prevPeriodStart: studioLocalDateKeyToUtcAnchor(prevStartKey, timezone),
      prevPeriodEnd: prevEnd,
      isPartialPeriod: false,
    };
  }

  if (period === 'this_year') {
    const [year] = nowKey.split('-');
    const { periodStart } = monthBoundsFromKey(`${year}-01`, timezone);
    const prevYearStart = studioLocalDateKeyToUtcAnchor(`${Number(year) - 1}-01-01`, timezone);
    const elapsedMs = now.getTime() - periodStart.getTime();
    return {
      period,
      timezone,
      periodStart,
      periodEnd: now,
      prevPeriodStart: prevYearStart,
      prevPeriodEnd: new Date(prevYearStart.getTime() + elapsedMs),
      isPartialPeriod: true,
    };
  }

  if (period === 'prev_month') {
    const [yearStr, monthStr] = nowKey.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const monthKey = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
    const { periodStart, periodEndExclusive } = monthBoundsFromKey(monthKey, timezone);
    const priorMonth = prevMonth === 1 ? 12 : prevMonth - 1;
    const priorYear = prevMonth === 1 ? prevYear - 1 : prevYear;
    const priorKey = `${priorYear}-${String(priorMonth).padStart(2, '0')}`;
    const prior = monthBoundsFromKey(priorKey, timezone);
    return {
      period,
      timezone,
      periodStart,
      periodEnd: new Date(periodEndExclusive.getTime() - 1),
      prevPeriodStart: prior.periodStart,
      prevPeriodEnd: new Date(prior.periodEndExclusive.getTime() - 1),
      isPartialPeriod: false,
    };
  }

  if (period === 'custom' && customFrom && customTo) {
    const periodStart = studioLocalDateKeyToUtcAnchor(customFrom, timezone);
    const endExclusive = studioLocalDateKeyToUtcAnchor(addDaysToDateKey(customTo, 1), timezone);
    const periodEnd = new Date(Math.min(now.getTime(), endExclusive.getTime() - 1));
    const durationMs = periodEnd.getTime() - periodStart.getTime() + 1;
    const prevPeriodEnd = new Date(periodStart.getTime() - 1);
    const prevPeriodStart = new Date(prevPeriodEnd.getTime() - durationMs + 1);
    return {
      period,
      timezone,
      periodStart,
      periodEnd,
      prevPeriodStart,
      prevPeriodEnd,
      isPartialPeriod: periodEnd < new Date(endExclusive.getTime() - 1),
    };
  }

  const [yearStr, monthStr] = nowKey.split('-');
  const { periodStart } = monthBoundsFromKey(`${yearStr}-${monthStr}`, timezone);
  const prevMonth = Number(monthStr) === 1 ? 12 : Number(monthStr) - 1;
  const prevYear = Number(monthStr) === 1 ? Number(yearStr) - 1 : Number(yearStr);
  const prevKey = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
  const prev = monthBoundsFromKey(prevKey, timezone);

  return {
    period: 'this_month',
    timezone,
    periodStart,
    periodEnd: now,
    prevPeriodStart: prev.periodStart,
    prevPeriodEnd: new Date(prev.periodEndExclusive.getTime() - 1),
    isPartialPeriod: true,
  };
}

export function rollingWindowStart(now: Date, timezone: string, days: number): Date {
  const nowKey = getStudioLocalDateKey(now, timezone);
  return studioLocalDateKeyToUtcAnchor(addDaysToDateKey(nowKey, -(days - 1)), timezone);
}
