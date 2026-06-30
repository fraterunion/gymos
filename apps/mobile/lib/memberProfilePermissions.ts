/**
 * Member profile access — mobile UI gating.
 * Read endpoints on API also allow STAFF; write/sales actions use separate permission helpers.
 */
export const MEMBER_PROFILE_READ_ROLES = new Set(['OWNER', 'ADMIN', 'FRONT_DESK', 'STAFF']);

export function canAccessMemberProfile(role: string | null | undefined): boolean {
  return Boolean(role && MEMBER_PROFILE_READ_ROLES.has(role));
}
