import { BookingStatus, CancelSource, WaitlistStatus, type Prisma } from '@prisma/client';

export type ClassCancellationCascadeResult = {
  cancelledBookingCount: number;
  expiredWaitlistCount: number;
};

/**
 * After ScheduledClass rows are marked CANCELLED, close live member reservations
 * for those occurrences. Never deletes attendance or other history.
 */
export async function cascadeClassCancellationInTx(
  tx: Prisma.TransactionClient,
  input: {
    studioId: string;
    scheduledClassIds: string[];
    now?: Date;
  },
): Promise<ClassCancellationCascadeResult> {
  const ids = [...new Set(input.scheduledClassIds)].filter(Boolean);
  if (ids.length === 0) {
    return { cancelledBookingCount: 0, expiredWaitlistCount: 0 };
  }

  const now = input.now ?? new Date();
  const bookings = await tx.booking.updateMany({
    where: {
      studioId: input.studioId,
      scheduledClassId: { in: ids },
      status: BookingStatus.CONFIRMED,
    },
    data: {
      status: BookingStatus.CANCELLED,
      cancelSource: CancelSource.STUDIO,
      cancelledAt: now,
    },
  });
  const waitlist = await tx.waitlistEntry.updateMany({
    where: {
      studioId: input.studioId,
      scheduledClassId: { in: ids },
      status: WaitlistStatus.WAITING,
    },
    data: { status: WaitlistStatus.EXPIRED },
  });

  return {
    cancelledBookingCount: bookings.count,
    expiredWaitlistCount: waitlist.count,
  };
}
