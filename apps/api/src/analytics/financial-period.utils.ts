/**
 * Studio-local financial period boundaries for owner dashboard KPIs.
 *
 * Collected-at: COALESCE(paid_at, created_at) on Payment rows.
 * Comparisons use aligned prior periods (same elapsed time for today/week/year).
 */

import {
  addDaysToDateKey,
  getDayOfWeekFromDateKey,
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
} from '../common/date/studio-local-date';
import { dayWindows, monthComparisonWindows, pctChange } from './owner-briefing.utils';

export type FinancialPeriodKey = 'today' | 'week' | 'month' | 'year';

export const FINANCIAL_PERIOD_LABELS: Record<FinancialPeriodKey, string> = {
  today: 'Hoy',
  week: 'Esta semana',
  month: 'Este mes',
  year: 'Este año',
};

export type FinancialPeriodWindows = {
  period: FinancialPeriodKey;
  timezone: string;
  periodStart: Date;
  periodEnd: Date;
  prevPeriodStart: Date;
  prevPeriodEnd: Date;
};

export function financialPeriodWindows(
  now: Date,
  timezone: string,
  period: FinancialPeriodKey,
): FinancialPeriodWindows {
  const nowKey = getStudioLocalDateKey(now, timezone);

  if (period === 'today') {
    const { todayStart, yesterdayStart, yesterdaySamePointEnd } = dayWindows(now, timezone);
    return {
      period,
      timezone,
      periodStart: todayStart,
      periodEnd: now,
      prevPeriodStart: yesterdayStart,
      prevPeriodEnd: yesterdaySamePointEnd,
    };
  }

  if (period === 'week') {
    const dow = getDayOfWeekFromDateKey(nowKey);
    const daysFromMonday = dow === 0 ? 6 : dow - 1;
    const weekStartKey = addDaysToDateKey(nowKey, -daysFromMonday);
    const weekStart = studioLocalDateKeyToUtcAnchor(weekStartKey, timezone);
    const prevWeekStartKey = addDaysToDateKey(weekStartKey, -7);
    const prevWeekStart = studioLocalDateKeyToUtcAnchor(prevWeekStartKey, timezone);
    const elapsedMs = now.getTime() - weekStart.getTime();
    const prevPeriodEnd = new Date(prevWeekStart.getTime() + elapsedMs);
    return {
      period,
      timezone,
      periodStart: weekStart,
      periodEnd: now,
      prevPeriodStart: prevWeekStart,
      prevPeriodEnd,
    };
  }

  if (period === 'month') {
    const { monthStart, prevMonthStart, prevPeriodEnd, now: periodEnd } =
      monthComparisonWindows(now, timezone);
    return {
      period,
      timezone,
      periodStart: monthStart,
      periodEnd,
      prevPeriodStart: prevMonthStart,
      prevPeriodEnd,
    };
  }

  const [year] = nowKey.split('-').map(Number);
  const yearStartKey = `${year}-01-01`;
  const yearStart = studioLocalDateKeyToUtcAnchor(yearStartKey, timezone);
  const prevYearStart = studioLocalDateKeyToUtcAnchor(`${year! - 1}-01-01`, timezone);
  const elapsedMs = now.getTime() - yearStart.getTime();
  const prevPeriodEnd = new Date(prevYearStart.getTime() + elapsedMs);

  return {
    period,
    timezone,
    periodStart: yearStart,
    periodEnd: now,
    prevPeriodStart: prevYearStart,
    prevPeriodEnd,
  };
}

export { pctChange };
