/** Mirrors `apps/api/src/check-ins/check-ins.service.ts` check-in window. */
const LATE_MS = 30 * 60 * 1000;

export function isWithinCheckInWindow(classStartsAt: Date | string, now: Date = new Date()): boolean {
  const startMs = new Date(classStartsAt).getTime();
  const nowMs = now.getTime();
  return nowMs <= startMs + LATE_MS;
}

export function msUntilCheckInOpens(_classStartsAt: Date | string, _now: Date = new Date()): number {
  return 0;
}

export function msUntilCheckInCloses(classStartsAt: Date | string, now: Date = new Date()): number {
  const startMs = new Date(classStartsAt).getTime();
  return Math.max(0, startMs + LATE_MS - now.getTime());
}

export function isBeforeCheckInWindow(_classStartsAt: Date | string, _now: Date = new Date()): boolean {
  return false;
}

export function isAfterCheckInWindow(classStartsAt: Date | string, now: Date = new Date()): boolean {
  const startMs = new Date(classStartsAt).getTime();
  return now.getTime() > startMs + LATE_MS;
}
