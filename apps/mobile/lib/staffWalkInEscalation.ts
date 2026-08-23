/**
 * Class walk-in CTA — never implies an Open Gym / facility-access override.
 * Shown only when Front Desk may escalate to a specific ScheduledClass.
 */
export const CLASS_WALK_IN_CTA_LABEL = 'Registrar en una clase';

/**
 * Whether Front Desk may offer the class walk-in escalation from a scan result.
 *
 * Product policy: a member with no current membership (`not_entitled`) gets denial
 * only — no escalation from this screen. Entitled members who cannot use Open Gym
 * (or legacy no-booking) may still be walked into a specific class.
 *
 * Authorization for the walk-in itself remains on POST …/manual-attendance.
 * Pass `canRegisterManualAttendance` from the role helper — this function does not
 * re-derive roles so unit tests stay free of Expo path aliases.
 */
export function shouldOfferClassWalkInEscalation(input: {
  outcome: string | undefined;
  /** From Open Gym denial navigation; ignored for `no_booking`. */
  openGymDenialReason?: 'not_included' | 'outside_hours' | 'not_entitled' | string | null;
  canRegisterManualAttendance: boolean;
  walkInCandidateCount: number;
}): boolean {
  if (input.walkInCandidateCount <= 0) return false;
  if (!input.canRegisterManualAttendance) return false;

  if (input.outcome === 'no_booking') return true;

  if (input.outcome === 'denied') {
    if (input.openGymDenialReason === 'not_entitled') return false;
    return true;
  }

  return false;
}
