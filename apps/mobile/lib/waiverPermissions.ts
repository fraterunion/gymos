/**
 * Waiver attestation roles — mirrors API WaiverController:
 * POST /studios/:studioId/members/:userId/waiver-attestation
 * @Roles(Role.OWNER, Role.ADMIN, Role.FRONT_DESK)
 *
 * STAFF and INSTRUCTOR are not backend-authorized to attest; mobile must not
 * expose attestation UI for those roles (backend returns 403 if called anyway).
 */
export const WAIVER_ATTESTATION_ROLES = new Set(['OWNER', 'ADMIN', 'FRONT_DESK']);

/** Read waiver status — API also allows STAFF (GET only). */
export const WAIVER_STATUS_READ_ROLES = new Set(['OWNER', 'ADMIN', 'STAFF', 'FRONT_DESK']);

export function canAttestMemberWaiver(role: string | null | undefined): boolean {
  return Boolean(role && WAIVER_ATTESTATION_ROLES.has(role));
}
