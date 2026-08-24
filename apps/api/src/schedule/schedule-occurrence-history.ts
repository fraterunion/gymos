/**
 * Shared definition of "operational / historical state" on a ScheduledClass occurrence.
 * Week reconciliation and Admin create-path reactivation MUST agree on this predicate.
 *
 * Counts are expected to match reconciliation loaders:
 * - bookingCount: CONFIRMED bookings only
 * - attendanceCount: any Attendance row
 * - waitlistCount: WAITING waitlist entries only
 */
export type OccurrenceHistoryCounts = {
  bookingCount: number;
  attendanceCount: number;
  waitlistCount: number;
};

/** True when automatic reactivation of a CANCELLED occurrence is unsafe. */
export function hasOperationalHistory(row: OccurrenceHistoryCounts): boolean {
  return row.bookingCount > 0 || row.attendanceCount > 0 || row.waitlistCount > 0;
}

/** Machine-readable conflict when a CANCELLED slot with history blocks create. */
export const SCHEDULE_SLOT_CANCELLED_WITH_HISTORY_CODE =
  'SCHEDULE_SLOT_CANCELLED_WITH_HISTORY';
