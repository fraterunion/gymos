/** Mirrors `apps/api/src/check-ins/check-in-window.utils.ts`. */
export const CHECK_IN_LATE_GRACE_MINUTES = 30;
export const DEFAULT_CHECK_IN_EARLY_MINUTES = 15;

export function getCheckInWindowBounds(
  classStartsAt: Date | string,
  earlyOpenMinutes: number = DEFAULT_CHECK_IN_EARLY_MINUTES,
  lateGraceMinutes: number = CHECK_IN_LATE_GRACE_MINUTES,
): { opensAt: Date; closesAt: Date } {
  const startMs = new Date(classStartsAt).getTime();
  return {
    opensAt: new Date(startMs - earlyOpenMinutes * 60_000),
    closesAt: new Date(startMs + lateGraceMinutes * 60_000),
  };
}

export function isWithinCheckInWindow(
  classStartsAt: Date | string,
  now: Date = new Date(),
  earlyOpenMinutes: number = DEFAULT_CHECK_IN_EARLY_MINUTES,
  lateGraceMinutes: number = CHECK_IN_LATE_GRACE_MINUTES,
): boolean {
  const { opensAt, closesAt } = getCheckInWindowBounds(
    classStartsAt,
    earlyOpenMinutes,
    lateGraceMinutes,
  );
  const nowMs = now.getTime();
  return nowMs >= opensAt.getTime() && nowMs <= closesAt.getTime();
}

export function isBeforeCheckInWindow(
  classStartsAt: Date | string,
  now: Date = new Date(),
  earlyOpenMinutes: number = DEFAULT_CHECK_IN_EARLY_MINUTES,
): boolean {
  const { opensAt } = getCheckInWindowBounds(classStartsAt, earlyOpenMinutes);
  return now.getTime() < opensAt.getTime();
}

export function isAfterCheckInWindow(
  classStartsAt: Date | string,
  now: Date = new Date(),
  lateGraceMinutes: number = CHECK_IN_LATE_GRACE_MINUTES,
): boolean {
  const { closesAt } = getCheckInWindowBounds(
    classStartsAt,
    DEFAULT_CHECK_IN_EARLY_MINUTES,
    lateGraceMinutes,
  );
  return now.getTime() > closesAt.getTime();
}

export function msUntilCheckInOpens(
  classStartsAt: Date | string,
  now: Date = new Date(),
  earlyOpenMinutes: number = DEFAULT_CHECK_IN_EARLY_MINUTES,
): number {
  const { opensAt } = getCheckInWindowBounds(classStartsAt, earlyOpenMinutes);
  return Math.max(0, opensAt.getTime() - now.getTime());
}

export function msUntilCheckInCloses(
  classStartsAt: Date | string,
  now: Date = new Date(),
  lateGraceMinutes: number = CHECK_IN_LATE_GRACE_MINUTES,
): number {
  const { closesAt } = getCheckInWindowBounds(
    classStartsAt,
    DEFAULT_CHECK_IN_EARLY_MINUTES,
    lateGraceMinutes,
  );
  return Math.max(0, closesAt.getTime() - now.getTime());
}
