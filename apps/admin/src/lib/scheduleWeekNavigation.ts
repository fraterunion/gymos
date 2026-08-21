/** Admin calendar week navigation — self-contained for node:test (no workspace package imports). */

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export function shiftDateKey(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function todayKeyInZone(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function weekdayIndexInZone(timeZone: string, at: Date = new Date()): number {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
  return WEEKDAY_INDEX[weekday] ?? 0;
}

function calendarDayKeyInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

export function mondayStartKeyForInstant(iso: string, timeZone: string): string {
  const key = calendarDayKeyInZone(iso, timeZone);
  const weekday = weekdayIndexInZone(timeZone, new Date(iso));
  return shiftDateKey(key, -weekday);
}

export function currentWeekStartKey(timeZone: string, at: Date = new Date()): string {
  const todayKey = todayKeyInZone(timeZone, at);
  return shiftDateKey(todayKey, -weekdayIndexInZone(timeZone, at));
}

/** Resolve the Monday start key for calendar display (studio-local). */
export function resolveDisplayWeekStartKey(
  displayWeekStartKey: string | null,
  urlWeekStart: string | null,
  timeZone: string,
): string {
  if (displayWeekStartKey) return displayWeekStartKey;
  if (urlWeekStart) return mondayStartKeyForInstant(urlWeekStart, timeZone);
  return currentWeekStartKey(timeZone);
}

/** Shift displayed week by exactly N weeks (negative = past). */
export function shiftDisplayWeekStartKey(
  currentStartKey: string,
  deltaWeeks: number,
): string {
  return shiftDateKey(currentStartKey, deltaWeeks * 7);
}

/** Week bounds derived from an explicit Monday start key. */
export function weekBoundsFromStartKey(startKey: string, timeZone: string) {
  const endKey = shiftDateKey(startKey, 6);
  const startLabel = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${startKey}T12:00:00Z`));
  const endLabel = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${endKey}T12:00:00Z`));
  return {
    startKey,
    endKey,
    label: `${startLabel} – ${endLabel}`,
  };
}
