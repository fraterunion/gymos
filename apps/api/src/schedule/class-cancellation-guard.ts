import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * A class that has already started (in progress or past) is history: cancelling it would flip
 * its CONFIRMED bookings — including members who attended — to CANCELLED while the attendance
 * stays. Every cancellation path refuses such a class, and bulk paths leave it untouched.
 */
export const STARTED_CLASS_CANCEL_MESSAGE =
  'Esta clase ya comenzó o ya terminó. No se puede cancelar para no alterar asistencias ni reservaciones.';

/** Prisma filter for classes a bulk cancellation may touch. Combine with the caller's own filter. */
export function cancellableClassWhere(now: Date): Prisma.ScheduledClassWhereInput {
  return { startsAt: { gt: now } };
}

export function assertClassNotStarted(scheduledClass: { startsAt: Date }, now: Date = new Date()): void {
  if (scheduledClass.startsAt.getTime() <= now.getTime()) {
    throw new BadRequestException(STARTED_CLASS_CANCEL_MESSAGE);
  }
}
