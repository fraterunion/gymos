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

/** Shift a YYYY-MM-DD key by delta days (UTC-safe for keys). */
export function shiftDateKey(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
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

/** UI-only: whether desk/mobile should expose check-in actions for this class. */
export function canOperateClassCheckIn(
  classStartsAt: string,
  checkInWindowMinutes: number = 15,
  now: Date = new Date(),
): boolean {
  return isWithinCheckInWindow(classStartsAt, now, checkInWindowMinutes);
}

export function formatDateKeyLabel(dayKey: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${dayKey}T12:00:00Z`));
}
