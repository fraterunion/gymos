/**
 * Owner briefing metric definitions (see apps/admin OwnerBriefing + READY FOR REVIEW).
 *
 * Collected revenue: Payment rows with status SUCCEEDED only (confirmed collected).
 * Collected-at timestamp: COALESCE(paid_at, created_at) — paid_at is set at Stripe/cash confirmation.
 * Payment count: Count of those payment rows in the period by collected-at.
 * Paying members: DISTINCT user_id with ≥1 ACTIVE or TRIALING subscription for the studio.
 * New memberships: New StudioMembership rows with role MEMBER (not subscription creation).
 * Expiring soon: DISTINCT user_id with ACTIVE/TRIALING and currentPeriodEnd in (now, now+7d].
 *
 * Time windows (studio-local calendar via studio.timezone IANA string):
 * - This month: local month start → now
 * - Today (intraday): local today 00:00 → now; yesterday comparison uses the same elapsed window
 * - Since yesterday: local yesterday 00:00 → now
 * - This week: rolling 7×24h ending at now (for new paying members)
 */

import {
  addDaysToDateKey,
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
} from '../common/date/studio-local-date';

/** SQL expression for when a succeeded payment was collected. */
export const PAYMENT_COLLECTED_AT_SQL = 'COALESCE(paid_at, created_at)';

export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Studio-local calendar month boundaries for MTD and same-point-last-month comparison. */
export function monthComparisonWindows(now: Date, timezone: string) {
  const nowKey = getStudioLocalDateKey(now, timezone);
  const [year, month, day] = nowKey.split('-').map(Number);

  const monthStartKey = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthStart = studioLocalDateKeyToUtcAnchor(monthStartKey, timezone);

  const prevMonthFirst = new Date(Date.UTC(year!, month! - 2, 1));
  const prevYear = prevMonthFirst.getUTCFullYear();
  const prevMonth = prevMonthFirst.getUTCMonth() + 1;
  const prevMonthStartKey = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`;
  const prevMonthStart = studioLocalDateKeyToUtcAnchor(prevMonthStartKey, timezone);

  const lastDayPrevMonth = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  const alignedDay = Math.min(day!, lastDayPrevMonth);
  const alignedDayKey = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(alignedDay).padStart(2, '0')}`;
  const prevPeriodEnd = studioLocalDateKeyToUtcAnchor(
    addDaysToDateKey(alignedDayKey, 1),
    timezone,
  );

  return { monthStart, prevMonthStart, prevPeriodEnd, now };
}

export function dayWindows(now: Date, timezone: string) {
  const todayKey = getStudioLocalDateKey(now, timezone);
  const todayStart = studioLocalDateKeyToUtcAnchor(todayKey, timezone);
  const tomorrowStart = studioLocalDateKeyToUtcAnchor(addDaysToDateKey(todayKey, 1), timezone);
  const yesterdayStart = studioLocalDateKeyToUtcAnchor(addDaysToDateKey(todayKey, -1), timezone);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const elapsedTodayMs = now.getTime() - todayStart.getTime();
  const yesterdaySamePointEnd = new Date(yesterdayStart.getTime() + elapsedTodayMs);

  return { todayStart, tomorrowStart, yesterdayStart, yesterdaySamePointEnd, weekAgo, weekAhead };
}

export type BriefingDelight =
  | 'Strong month.'
  | 'Revenue is ahead of last month.'
  | 'Everything looks healthy.'
  | 'Membership activity is strong.';

export function pickDelightSentence(input: {
  monthComparisonPercent: number | null;
  attentionItemCount: number;
  newMembershipsThisWeek: number;
  monthCollectedCents: number;
  prevMonthCollectedCents: number;
}): BriefingDelight | null {
  const {
    monthComparisonPercent,
    attentionItemCount,
    newMembershipsThisWeek,
    monthCollectedCents,
    prevMonthCollectedCents,
  } = input;

  if (monthCollectedCents === 0 && prevMonthCollectedCents === 0) {
    return null;
  }

  if (attentionItemCount > 0) {
    return null;
  }

  if (monthComparisonPercent != null && monthComparisonPercent >= 10) {
    return 'Strong month.';
  }

  if (monthCollectedCents > prevMonthCollectedCents && prevMonthCollectedCents > 0) {
    return 'Revenue is ahead of last month.';
  }

  if (newMembershipsThisWeek >= 3) {
    return 'Membership activity is strong.';
  }

  if (monthCollectedCents >= prevMonthCollectedCents) {
    return 'Everything looks healthy.';
  }

  return null;
}
