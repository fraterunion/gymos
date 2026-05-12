/** YYYY-MM-DD in IANA time zone. */
export function calendarDayKeyInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function todayKeyInZone(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function formatClassRange(startIso: string, endIso: string, timeZone: string): string {
  const d = new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(startIso));
  const t1 = new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(startIso));
  const t2 = new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(endIso));
  return `${d} · ${t1} – ${t2}`;
}

export function buildScheduleQueryRange(): { from: string; to: string } {
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 1);
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + 14);
  to.setUTCHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}
