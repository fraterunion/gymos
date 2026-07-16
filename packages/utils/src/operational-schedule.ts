/**
 * Canonical operational (staff/admin) schedule visibility and week-boundary helpers.
 * Admin Web and Mobile Staff Horario must share this logic.
 */

export const OPERATIONAL_SCHEDULE_STATUS = 'SCHEDULED' as const;

export type OperationalScheduleRow = {
  id: string;
  studioId: string;
  startsAt: string;
  status: string;
  classTemplate?: { deletedAt?: string | Date | null; name?: string };
  instructorId?: string | null;
  bookedCount?: number;
  capacity?: number;
};

/** Active operational calendar row: scheduled and template not soft-deleted. */
export function isOperationalScheduleClass(
  row: Pick<OperationalScheduleRow, 'status'> & {
    classTemplate?: { deletedAt?: string | Date | null };
  },
): boolean {
  if (row.status !== OPERATIONAL_SCHEDULE_STATUS) return false;
  if (row.classTemplate?.deletedAt != null) return false;
  return true;
}

export function filterOperationalScheduleClasses<T extends OperationalScheduleRow>(rows: T[]): T[] {
  return rows.filter(isOperationalScheduleClass);
}

export function calendarDayKeyInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

export function shiftDateKey(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function getTimezoneOffsetMs(utcInstant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(utcInstant);

  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  const localAsUtcMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );

  return localAsUtcMs - utcInstant.getTime();
}

/** UTC instant for studio-local midnight on a YYYY-MM-DD key. */
export function studioLocalDateKeyToUtcAnchor(dateKey: string, timezone: string): Date {
  const [yearStr, monthStr, dayStr] = dateKey.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const utcMidnight = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offsetMs = getTimezoneOffsetMs(utcMidnight, timezone);
  return new Date(utcMidnight.getTime() - offsetMs);
}

/** Inclusive studio-local week keys → exclusive-end UTC overlap query for schedule API. */
export function studioWeekQueryRangeIso(
  startKey: string,
  endKey: string,
  timeZone: string,
): { from: string; to: string } {
  const from = studioLocalDateKeyToUtcAnchor(startKey, timeZone);
  const dayAfterEnd = shiftDateKey(endKey, 1);
  const to = studioLocalDateKeyToUtcAnchor(dayAfterEnd, timeZone);
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

export function todayKeyInZone(timeZone: string, at: Date = new Date()): string {
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

/** Monday-start week bounds as YYYY-MM-DD keys in studio timezone. */
export function weekBoundsInZone(
  timeZone: string,
  weekOffset: number,
  at: Date = new Date(),
): { startKey: string; endKey: string; label: string } {
  const todayKey = todayKeyInZone(timeZone, at);
  const mondayKey = shiftDateKey(todayKey, -weekdayIndexInZone(timeZone, at));
  const startKey = shiftDateKey(mondayKey, weekOffset * 7);
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

export function weekDayKeysFromStart(startKey: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < 7; i++) {
    keys.push(shiftDateKey(startKey, i));
  }
  return keys;
}

export function filterOperationalScheduleInWeek<T extends OperationalScheduleRow>(
  rows: T[],
  startKey: string,
  endKey: string,
  timeZone: string,
  studioId?: string,
): T[] {
  return filterOperationalScheduleClasses(rows)
    .filter((row) => (studioId ? row.studioId === studioId : true))
    .filter((row) => {
      const key = calendarDayKeyInZone(row.startsAt, timeZone);
      return key >= startKey && key <= endKey;
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

export function operationalScheduleActiveIds<T extends OperationalScheduleRow>(
  rows: T[],
  startKey: string,
  endKey: string,
  timeZone: string,
  studioId?: string,
): string[] {
  return filterOperationalScheduleInWeek(rows, startKey, endKey, timeZone, studioId).map(
    (row) => row.id,
  );
}

/** Deterministic reconciliation helper for Admin Web vs Mobile Staff Horario. */
export function reconcileOperationalScheduleIds(
  adminIds: Iterable<string>,
  mobileIds: Iterable<string>,
): { match: boolean; onlyInAdmin: string[]; onlyInMobile: string[] } {
  const admin = new Set(adminIds);
  const mobile = new Set(mobileIds);
  const onlyInAdmin = [...admin].filter((id) => !mobile.has(id)).sort();
  const onlyInMobile = [...mobile].filter((id) => !admin.has(id)).sort();
  return {
    match: onlyInAdmin.length === 0 && onlyInMobile.length === 0,
    onlyInAdmin,
    onlyInMobile,
  };
}

/** Monday YYYY-MM-DD key containing the given instant in studio timezone. */
export function mondayStartKeyForInstant(iso: string, timeZone: string): string {
  const key = calendarDayKeyInZone(iso, timeZone);
  const weekday = weekdayIndexInZone(timeZone, new Date(iso));
  return shiftDateKey(key, -weekday);
}

/** Week offset from a Monday startKey relative to the current week in studio TZ. */
export function weekOffsetFromMondayStartKey(
  mondayStartKey: string,
  timeZone: string,
  at: Date = new Date(),
): number {
  const currentMonday = weekBoundsInZone(timeZone, 0, at).startKey;
  const [y1, m1, d1] = mondayStartKey.split('-').map(Number);
  const [y2, m2, d2] = currentMonday.split('-').map(Number);
  const a = Date.UTC(y1!, m1! - 1, d1!);
  const b = Date.UTC(y2!, m2! - 1, d2!);
  return Math.round((a - b) / (7 * 86_400_000));
}
