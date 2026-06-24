/** YYYY-MM-DD in the given IANA time zone (for grouping / "today"). */
export function calendarDayKeyInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

export function todayKeyInZone(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function formatClassTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatClassDateLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

export function formatClassRange(startIso: string, endIso: string, timeZone: string): string {
  const d = new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(startIso));
  const t1 = formatClassTime(startIso, timeZone);
  const t2 = formatClassTime(endIso, timeZone);
  return `${d} · ${t1} – ${t2}`;
}

/** Wide UTC window for schedule overlap queries (server clips by overlap). */
export function buildScheduleQueryRange(): { from: string; to: string } {
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 1);
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + 42);
  to.setUTCHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

function shiftDayKey(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function weekdayIndexInZone(timeZone: string, at: Date = new Date()): number {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
  return WEEKDAY_INDEX[weekday] ?? 0;
}

/** Monday-start week bounds as YYYY-MM-DD keys in studio timezone. */
export function weekBoundsInZone(
  timeZone: string,
  weekOffset: number,
  at: Date = new Date(),
): { startKey: string; endKey: string; label: string } {
  const todayKey = todayKeyInZone(timeZone, at);
  const mondayKey = shiftDayKey(todayKey, -weekdayIndexInZone(timeZone, at));
  const startKey = shiftDayKey(mondayKey, weekOffset * 7);
  const endKey = shiftDayKey(startKey, 6);

  const startLabel = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${startKey}T12:00:00Z`));
  const endLabel = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${endKey}T12:00:00Z`));

  return {
    startKey,
    endKey,
    label: `${startLabel} – ${endLabel}`,
  };
}
