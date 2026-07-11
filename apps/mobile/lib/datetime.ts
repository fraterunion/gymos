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

/** Presentation helper — mirrors API check-in window (studio default early minutes). */
export function isWithinCheckInWindow(
  classStartsAt: string,
  now: Date = new Date(),
  earlyOpenMinutes: number = 15,
  lateGraceMinutes: number = 30,
): boolean {
  const startMs = new Date(classStartsAt).getTime();
  const nowMs = now.getTime();
  return (
    nowMs >= startMs - earlyOpenMinutes * 60_000 &&
    nowMs <= startMs + lateGraceMinutes * 60_000
  );
}

/** UI-only: whether staff should expose check-in actions for this class. */
export function canOperateClassCheckIn(
  classStartsAt: string,
  checkInWindowMinutes: number = 15,
  now: Date = new Date(),
): boolean {
  return isWithinCheckInWindow(classStartsAt, now, checkInWindowMinutes);
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

/** Seven YYYY-MM-DD keys from Monday through Sunday for a week starting at `startKey`. */
export function weekDayKeysFromStart(startKey: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < 7; i++) {
    keys.push(shiftDayKey(startKey, i));
  }
  return keys;
}

export function weekdayShortLabel(dayKey: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-MX', { timeZone, weekday: 'short' })
      .format(new Date(`${dayKey}T12:00:00Z`))
      .replace('.', '')
      .slice(0, 3);
  } catch {
    return new Intl.DateTimeFormat('es-MX', { weekday: 'short' }).format(new Date(`${dayKey}T12:00:00Z`));
  }
}

export function dayOfMonthLabel(dayKey: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-MX', { timeZone, day: 'numeric' }).format(
      new Date(`${dayKey}T12:00:00Z`),
    );
  } catch {
    return dayKey.slice(8, 10);
  }
}
