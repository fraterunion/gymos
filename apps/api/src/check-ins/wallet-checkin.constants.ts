/**
 * Machine-readable outcome codes for the Wallet smart-booking check-in path, thrown as
 * exception messages (matching this codebase's existing convention — see
 * MEMBERSHIP_EXPIRED_MESSAGE in memberships/membership-entitlement.ts).
 */
export const WALLET_CREDENTIAL_INVALID_MESSAGE = 'WALLET_CREDENTIAL_INVALID';
export const WALLET_CREDENTIAL_REVOKED_MESSAGE = 'WALLET_CREDENTIAL_REVOKED';
export const WALLET_WRONG_STUDIO_MESSAGE = 'WALLET_WRONG_STUDIO';
export const WALLET_MEMBER_NOT_ACTIVE_MESSAGE = 'WALLET_MEMBER_NOT_ACTIVE';
export const WALLET_NO_ELIGIBLE_BOOKING_MESSAGE = 'WALLET_NO_ELIGIBLE_BOOKING';
export const WALLET_ALREADY_CHECKED_IN_MESSAGE = 'WALLET_ALREADY_CHECKED_IN';
export const WALLET_MULTIPLE_ELIGIBLE_BOOKINGS_CODE = 'WALLET_MULTIPLE_ELIGIBLE_BOOKINGS';

export type WalletEligibleBookingCandidate = {
  bookingId: string;
  scheduledClassId: string;
  className: string;
  startsAt: string;
};
