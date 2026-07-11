import { BadRequestException } from '@nestjs/common';

/** Minutes after class start when check-in closes (ARES default; not studio-configurable). */
export const CHECK_IN_LATE_GRACE_MINUTES = 30;

export const CHECK_IN_WINDOW_CLOSED_MESSAGE =
  'Check-in is not available outside the allowed time window';

export const CHECK_IN_WINDOW_NOT_OPEN_MESSAGE =
  'Check-in is not yet available for this class';

export type CheckInWindowBounds = {
  opensAt: Date;
  closesAt: Date;
};

export function getCheckInWindowBounds(
  classStartsAt: Date,
  earlyOpenMinutes: number,
  lateGraceMinutes: number = CHECK_IN_LATE_GRACE_MINUTES,
): CheckInWindowBounds {
  const startMs = classStartsAt.getTime();
  return {
    opensAt: new Date(startMs - earlyOpenMinutes * 60_000),
    closesAt: new Date(startMs + lateGraceMinutes * 60_000),
  };
}

export function isWithinCheckInWindow(
  classStartsAt: Date,
  now: Date,
  earlyOpenMinutes: number,
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

export function assertWithinCheckInWindow(
  classStartsAt: Date,
  now: Date,
  earlyOpenMinutes: number,
  lateGraceMinutes: number = CHECK_IN_LATE_GRACE_MINUTES,
): void {
  const { opensAt, closesAt } = getCheckInWindowBounds(
    classStartsAt,
    earlyOpenMinutes,
    lateGraceMinutes,
  );
  const nowMs = now.getTime();
  if (nowMs < opensAt.getTime()) {
    throw new BadRequestException(CHECK_IN_WINDOW_NOT_OPEN_MESSAGE);
  }
  if (nowMs > closesAt.getTime()) {
    throw new BadRequestException(CHECK_IN_WINDOW_CLOSED_MESSAGE);
  }
}
