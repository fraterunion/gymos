import { addDaysToDateKey, getDayOfWeekFromDateKey, getStudioLocalDateKey } from '../common/date/studio-local-date';

/** Class-demand time is derived from ScheduledClass.startsAt, never Attendance.checkedInAt. */
export function formatClassScheduleTimeLocal(startsAt: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(startsAt);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
}

/** Studio-local weekday (0=Sunday … 6=Saturday) from class start time. */
export function getClassScheduleWeekdayLocal(startsAt: Date, timezone: string): number {
  const dateKey = getStudioLocalDateKey(startsAt, timezone);
  return getDayOfWeekFromDateKey(dateKey);
}

/** Monday-start studio-local week key (YYYY-MM-DD of week start). */
export function getStudioLocalWeekStartKey(date: Date, timezone: string): string {
  const dateKey = getStudioLocalDateKey(date, timezone);
  const dow = getDayOfWeekFromDateKey(dateKey);
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  return addDaysToDateKey(dateKey, -daysFromMonday);
}

/**
 * Consecutive active-week streak ending at the member's most recent active week
 * (or current week if active this week). Uses studio-local Monday-start weeks.
 */
export function computeConsecutiveActiveWeekStreak(
  activeWeekStartKeys: string[],
  referenceDate: Date,
  timezone: string,
): number {
  if (activeWeekStartKeys.length === 0) return 0;
  const active = new Set(activeWeekStartKeys);
  const mostRecent = activeWeekStartKeys.reduce((a, b) => (a > b ? a : b));
  const currentWeek = getStudioLocalWeekStartKey(referenceDate, timezone);
  let cursor = mostRecent > currentWeek ? mostRecent : currentWeek;
  if (!active.has(cursor) && active.has(mostRecent)) {
    cursor = mostRecent;
  }
  if (!active.has(cursor)) return 0;

  let streak = 0;
  while (active.has(cursor)) {
    streak++;
    cursor = addDaysToDateKey(cursor, -7);
  }
  return streak;
}

export function pickFavoriteByCount<T extends string | number>(
  rows: Array<{ key: T; cnt: number; tieBreak: string }>,
): T | null {
  if (rows.length === 0) return null;
  const best = rows.reduce((acc, row) => {
    if (!acc) return row;
    if (row.cnt > acc.cnt) return row;
    if (row.cnt === acc.cnt && row.tieBreak < acc.tieBreak) return row;
    return acc;
  });
  return best?.key ?? null;
}
