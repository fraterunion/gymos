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
