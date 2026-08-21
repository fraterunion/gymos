import { BookingStatus, ClassStatus } from '@prisma/client';

/** Strict interval overlap: adjacent classes (end === start) do NOT overlap. */
export function intervalsOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Occurrence end capped at template duration — guards corrupt endsAt rows. */
export function effectiveOccurrenceEnd(startsAt: Date, endsAt: Date, durationMinutes: number): Date {
  const nominalEnd = new Date(startsAt.getTime() + durationMinutes * 60_000);
  return new Date(Math.min(endsAt.getTime(), nominalEnd.getTime()));
}

export type OverlapOccurrenceInput = {
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
};

export function occurrencesOverlapEffective(
  existing: OverlapOccurrenceInput,
  target: OverlapOccurrenceInput,
): boolean {
  const existingEnd = effectiveOccurrenceEnd(
    existing.startsAt,
    existing.endsAt,
    existing.durationMinutes,
  );
  const targetEnd = effectiveOccurrenceEnd(
    target.startsAt,
    target.endsAt,
    target.durationMinutes,
  );
  return intervalsOverlap(existing.startsAt, existingEnd, target.startsAt, targetEnd);
}

/** Prisma where-clause for bookings that may block a member (first-pass filter). */
export function memberBookingOverlapCandidateWhere(input: {
  studioId: string;
  userId: string;
  targetScheduledClassId: string;
  targetStartsAt: Date;
  targetEndsAt: Date;
}) {
  return {
    studioId: input.studioId,
    userId: input.userId,
    status: BookingStatus.CONFIRMED,
    scheduledClassId: { not: input.targetScheduledClassId },
    scheduledClass: {
      status: ClassStatus.SCHEDULED,
      // Raw interval rectangle; effective-end clamping happens in JS so
      // in-progress classes (startedAt < now < effectiveEnd) still block.
      startsAt: { lt: input.targetEndsAt },
      endsAt: { gt: input.targetStartsAt },
    },
  } as const;
}

/** First-pass window for in-progress classes; effective-end clamping happens in JS. */
export const IN_PROGRESS_BOOKING_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function isConfirmedBookingVisibleOnMyBookings(
  startsAt: Date,
  endsAt: Date,
  durationMinutes: number,
  now: Date,
): boolean {
  if (startsAt.getTime() >= now.getTime()) {
    return true;
  }
  const effectiveEnd = effectiveOccurrenceEnd(startsAt, endsAt, durationMinutes);
  return now.getTime() < effectiveEnd.getTime();
}

export function memberUpcomingBookingClassWhere(now: Date): {
  status: typeof ClassStatus.SCHEDULED;
  OR: Array<{ startsAt: { gte: Date } } | { startsAt: { gte: Date; lt: Date } }>;
} {
  const lookback = new Date(now.getTime() - IN_PROGRESS_BOOKING_LOOKBACK_MS);
  return {
    status: ClassStatus.SCHEDULED,
    OR: [{ startsAt: { gte: now } }, { startsAt: { gte: lookback, lt: now } }],
  };
}

export function findEffectiveOverlapBooking<
  T extends {
    id: string;
    scheduledClass: {
      startsAt: Date;
      endsAt: Date;
      classTemplate: { durationMinutes: number };
    };
  },
>(
  candidates: T[],
  target: OverlapOccurrenceInput,
): T | undefined {
  return candidates.find((booking) =>
    occurrencesOverlapEffective(
      {
        startsAt: booking.scheduledClass.startsAt,
        endsAt: booking.scheduledClass.endsAt,
        durationMinutes: booking.scheduledClass.classTemplate.durationMinutes,
      },
      target,
    ),
  );
}
