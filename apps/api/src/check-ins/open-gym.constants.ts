/**
 * Outcome codes for the Open Gym (facility access) branch of the Front Desk scan, thrown as
 * exception messages to match this codebase's existing convention (see wallet-checkin.constants.ts).
 *
 * These deliberately replace WALLET_NO_ELIGIBLE_BOOKING for a member who is physically at the
 * door: "no reservation" describes a class, not a person's right to enter the building.
 */

/** Membership is valid, but the plan does not grant independent gym access. */
export const WALLET_OPEN_GYM_NOT_INCLUDED_CODE = 'WALLET_OPEN_GYM_NOT_INCLUDED';

/** Plan grants Open Gym, but the current studio-local time is outside its allowed hours. */
export const WALLET_OPEN_GYM_OUTSIDE_HOURS_CODE = 'WALLET_OPEN_GYM_OUTSIDE_HOURS';

/** No currently-entitled subscription: expired, cancelled, paused, or never had one. */
export const WALLET_MEMBERSHIP_NOT_ENTITLED_CODE = 'WALLET_MEMBERSHIP_NOT_ENTITLED';

/** Display label for an Open Gym visit wherever a class name would otherwise appear. */
export const OPEN_GYM_LABEL = 'Open Gym';

/**
 * How long after an Open Gym check-in a repeat scan of the same member at the same studio is
 * treated as the same visit rather than a new one.
 *
 * This is deliberately a short time window and NOT a per-calendar-day constraint: a member who
 * trains at 09:00 and returns at 18:00 made two real visits, and collapsing them would destroy
 * the traffic and frequency data this record exists to produce. The window only has to cover
 * the realistic causes of an accidental duplicate — a barcode read twice, or staff re-scanning
 * because they missed the confirmation.
 */
export const OPEN_GYM_DEDUPE_WINDOW_MINUTES = 3;
