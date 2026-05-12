/** Mirrors `apps/api/src/check-ins/check-ins.service.ts` check-in window. */
const EARLY_MS = 15 * 60 * 1000;
const LATE_MS = 30 * 60 * 1000;

export function isWithinCheckInWindow(classStartsAt: Date | string, now: Date = new Date()): boolean {
  const startMs = new Date(classStartsAt).getTime();
  const nowMs = now.getTime();
  return nowMs >= startMs - EARLY_MS && nowMs <= startMs + LATE_MS;
}

export function msUntilCheckInOpens(classStartsAt: Date | string, now: Date = new Date()): number {
  const startMs = new Date(classStartsAt).getTime();
  return Math.max(0, startMs - EARLY_MS - now.getTime());
}

export function msUntilCheckInCloses(classStartsAt: Date | string, now: Date = new Date()): number {
  const startMs = new Date(classStartsAt).getTime();
  return Math.max(0, startMs + LATE_MS - now.getTime());
}

export function isBeforeCheckInWindow(classStartsAt: Date | string, now: Date = new Date()): boolean {
  const startMs = new Date(classStartsAt).getTime();
  return now.getTime() < startMs - EARLY_MS;
}

export function isAfterCheckInWindow(classStartsAt: Date | string, now: Date = new Date()): boolean {
  const startMs = new Date(classStartsAt).getTime();
  return now.getTime() > startMs + LATE_MS;
}
