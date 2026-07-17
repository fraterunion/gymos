import { BookingStatus } from '@prisma/client';

/**
 * Booking statuses that consume a class credit for the billing period containing
 * the scheduled class start time.
 *
 * - CONFIRMED: reserved spot (existing behavior).
 * - COMPLETED: class finished — credit must not be released when status advances.
 *
 * Excluded (preserved product behavior):
 * - CANCELLED: no credit.
 * - NO_SHOW: does not consume (replacing CONFIRMED releases the credit).
 * - PENDING: not yet counted.
 */
export const CREDIT_CONSUMING_BOOKING_STATUSES: readonly BookingStatus[] = [
  BookingStatus.CONFIRMED,
  BookingStatus.COMPLETED,
];

export const MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE =
  'Membership class credits exhausted.';
