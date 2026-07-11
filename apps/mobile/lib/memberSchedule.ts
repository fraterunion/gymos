import { calendarDayKeyInZone, weekDayKeysFromStart } from '@/lib/datetime';
import type { ScheduledClassDto } from '@/lib/types/studio';

/**
 * Class-volume dots on the day selector:
 * - 0 classes → hollow indicator (no dots)
 * - 1 class → 1 dot (few)
 * - 2–3 classes → 2 dots (medium)
 * - 4+ classes → 3 dots (many)
 */
export function memberClassVolumeDots(classCount: number): 0 | 1 | 2 | 3 {
  if (classCount <= 0) return 0;
  if (classCount === 1) return 1;
  if (classCount <= 3) return 2;
  return 3;
}

const MONTH_ABBR_ES: Record<string, string> = {
  ene: 'ENE',
  feb: 'FEB',
  mar: 'MAR',
  abr: 'ABR',
  may: 'MAY',
  jun: 'JUN',
  jul: 'JUL',
  ago: 'AGO',
  sep: 'SEP',
  oct: 'OCT',
  nov: 'NOV',
  dic: 'DIC',
};

function monthAbbrevUpper(dayKey: string, timeZone: string): string {
  try {
    const raw = new Intl.DateTimeFormat('es-MX', { timeZone, month: 'short' })
      .format(new Date(`${dayKey}T12:00:00Z`))
      .replace('.', '')
      .toLowerCase();
    return MONTH_ABBR_ES[raw.slice(0, 3)] ?? raw.slice(0, 3).toUpperCase();
  } catch {
    return dayKey.slice(5, 7);
  }
}

function dayNumber(dayKey: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-MX', { timeZone, day: 'numeric' }).format(
      new Date(`${dayKey}T12:00:00Z`),
    );
  } catch {
    return String(Number(dayKey.slice(8, 10)));
  }
}

/** Compact member week label, e.g. `13 – 19 JUL` or `27 JUL – 2 AGO`. */
export function formatMemberWeekRangeLabel(
  startKey: string,
  endKey: string,
  timeZone: string,
): string {
  const startDay = dayNumber(startKey, timeZone);
  const endDay = dayNumber(endKey, timeZone);
  const startMonth = monthAbbrevUpper(startKey, timeZone);
  const endMonth = monthAbbrevUpper(endKey, timeZone);

  if (startMonth === endMonth) {
    return `${startDay} – ${endDay} ${startMonth}`;
  }
  return `${startDay} ${startMonth} – ${endDay} ${endMonth}`;
}

export function formatMemberWeekdayAbbrev(dayKey: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-MX', { timeZone, weekday: 'short' })
      .format(new Date(`${dayKey}T12:00:00Z`))
      .replace('.', '')
      .slice(0, 3)
      .toUpperCase();
  } catch {
    return '---';
  }
}

/** Selected-day heading: `Hoy` or `Lunes 13 de julio`. */
export function formatMemberDayHeading(
  dayKey: string,
  todayKey: string,
  timeZone: string,
): string {
  if (dayKey === todayKey) return 'Hoy';

  try {
    const weekday = new Intl.DateTimeFormat('es-MX', { timeZone, weekday: 'long' }).format(
      new Date(`${dayKey}T12:00:00Z`),
    );
    const day = new Intl.DateTimeFormat('es-MX', { timeZone, day: 'numeric' }).format(
      new Date(`${dayKey}T12:00:00Z`),
    );
    const month = new Intl.DateTimeFormat('es-MX', { timeZone, month: 'long' }).format(
      new Date(`${dayKey}T12:00:00Z`),
    );
    const cap = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    return `${cap} ${day} de ${month}`;
  } catch {
    return dayKey;
  }
}

/** Accessible day label, e.g. `Lunes 13 de julio, 3 clases`. */
export function formatMemberDayAccessibilityLabel(
  dayKey: string,
  todayKey: string,
  timeZone: string,
  classCount: number,
): string {
  const date =
    dayKey === todayKey
      ? 'Hoy'
      : formatMemberDayHeading(dayKey, '__not_today__', timeZone);
  const classes =
    classCount === 0
      ? 'sin clases'
      : classCount === 1
        ? '1 clase'
        : `${classCount} clases`;
  return `${date}, ${classes}`;
}

export function resolveDefaultMemberDayKey(
  weekDayKeys: string[],
  todayKey: string,
  classCountByDay: ReadonlyMap<string, number>,
): string {
  if (weekDayKeys.includes(todayKey)) return todayKey;
  const firstWithClasses = weekDayKeys.find((k) => (classCountByDay.get(k) ?? 0) > 0);
  return firstWithClasses ?? weekDayKeys[0] ?? todayKey;
}

export function buildMemberClassCountByDay(
  classes: ScheduledClassDto[],
  timeZone: string,
  weekStartKey: string,
  weekEndKey: string,
  nowMs: number = Date.now(),
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of classes) {
    if (row.status !== 'SCHEDULED') continue;
    if (new Date(row.startsAt).getTime() <= nowMs) continue;
    const key = calendarDayKeyInZone(row.startsAt, timeZone);
    if (key < weekStartKey || key > weekEndKey) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function filterMemberScheduleClasses(
  classes: ScheduledClassDto[],
  timeZone: string,
  dayKey: string,
  weekStartKey: string,
  weekEndKey: string,
  classFilterId: string,
  matchesFilter: (name: string, filterId: string) => boolean,
  nowMs: number = Date.now(),
): ScheduledClassDto[] {
  return classes
    .filter((row) => {
      if (row.status !== 'SCHEDULED') return false;
      if (new Date(row.startsAt).getTime() <= nowMs) return false;
      const key = calendarDayKeyInZone(row.startsAt, timeZone);
      if (key !== dayKey || key < weekStartKey || key > weekEndKey) return false;
      return matchesFilter(row.classTemplate.name, classFilterId);
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

export function memberWeekDayKeys(weekStartKey: string): string[] {
  return weekDayKeysFromStart(weekStartKey);
}
