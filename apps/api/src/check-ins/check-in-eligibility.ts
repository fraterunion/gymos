import { BadRequestException, ConflictException } from '@nestjs/common';
import { BookingStatus, ClassStatus } from '@prisma/client';
import { assertWithinCheckInWindow } from './check-in-window.utils';

export type CheckInBookingContext = {
  status: BookingStatus;
  studioId: string;
  scheduledClassId: string;
};

export type CheckInScheduledClassContext = {
  id: string;
  status: ClassStatus;
  startsAt: Date;
  studioId: string;
};

/**
 * Canonical booking + class + time-window validation for every attendance write path.
 * Roster reads must not call this.
 */
export function assertEligibleForCheckIn(
  booking: CheckInBookingContext,
  scheduledClass: CheckInScheduledClassContext,
  now: Date,
  checkInWindowMinutes: number,
): void {
  if (
    scheduledClass.id !== booking.scheduledClassId ||
    scheduledClass.studioId !== booking.studioId
  ) {
    throw new BadRequestException();
  }
  if (booking.status !== BookingStatus.CONFIRMED) {
    throw new ConflictException('Only confirmed bookings can be checked in');
  }
  if (scheduledClass.status !== ClassStatus.SCHEDULED) {
    throw new ConflictException('Check-in is only available for scheduled classes');
  }
  assertWithinCheckInWindow(scheduledClass.startsAt, now, checkInWindowMinutes);
}
