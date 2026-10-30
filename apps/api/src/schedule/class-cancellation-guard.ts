import { BadRequestException } from '@nestjs/common';
import { ClassStatus, type Prisma } from '@prisma/client';

/**
 * Cancellation safety policy. A class is PROTECTED — never cancelled, its bookings and waitlist
 * never touched, its attendance never rewritten — when it:
 *   - has already started (in progress) or ended, or is COMPLETED; or
 *   - is in the future but already has attendance (early check-in): cancelling it would leave
 *     an attendance without its booking.
 * Direct cancellation of a protected class is refused with an explanation. Range cancellations
 * (this-and-following, entire/permanent series, finish series) skip protected classes and report
 * how many they kept. Future classes without attendance cancel exactly as before.
 */
export const STARTED_CLASS_CANCEL_MESSAGE =
  'Esta clase ya comenzó o ya terminó. No se puede cancelar para no alterar asistencias ni reservaciones.';
export const ATTENDED_CLASS_CANCEL_MESSAGE =
  'Esta clase ya tiene asistencias registradas (check-in anticipado). No se puede cancelar para no dejar asistencias sin su reservación.';

export type ProtectedReason = 'STARTED' | 'ATTENDED';

export function protectedClassReason(
  cls: { startsAt: Date; status: ClassStatus; attendanceCount: number },
  now: Date = new Date(),
): ProtectedReason | null {
  if (cls.status === ClassStatus.COMPLETED || cls.startsAt.getTime() <= now.getTime()) return 'STARTED';
  if (cls.attendanceCount > 0) return 'ATTENDED';
  return null;
}

/** Throws a 400 with the explanation when a directly selected class is protected. */
export function assertNotProtected(reason: ProtectedReason | null): void {
  if (reason === 'STARTED') throw new BadRequestException(STARTED_CLASS_CANCEL_MESSAGE);
  if (reason === 'ATTENDED') throw new BadRequestException(ATTENDED_CLASS_CANCEL_MESSAGE);
}

type AttendanceReader = { attendance: { count(args: { where: Prisma.AttendanceWhereInput }): Promise<number> } };

export async function assertClassCancellable(
  db: AttendanceReader,
  studioId: string,
  cls: { id: string; startsAt: Date; status: ClassStatus },
  now: Date = new Date(),
): Promise<void> {
  const attendanceCount = await db.attendance.count({ where: { studioId, scheduledClassId: cls.id } });
  assertNotProtected(protectedClassReason({ ...cls, attendanceCount }, now));
}

/** Range filter: classes a bulk/range cancellation may touch (combine with the caller's filter). */
export function cancellableClassWhere(now: Date): Prisma.ScheduledClassWhereInput {
  return { startsAt: { gt: now }, attendances: { none: {} } };
}

/** Range filter: future classes kept because of early check-in (reported as skipped). */
export function attendedFutureClassWhere(now: Date): Prisma.ScheduledClassWhereInput {
  return { startsAt: { gt: now }, attendances: { some: {} } };
}
