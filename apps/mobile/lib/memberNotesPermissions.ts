/**
 * Operational notes — staff-only, not member-facing.
 * Mirrors API roles on GET/POST /members/:userId/operational-notes.
 */
export const MEMBER_NOTES_READ_ROLES = new Set(['OWNER', 'ADMIN', 'FRONT_DESK', 'STAFF']);

export const MEMBER_NOTES_WRITE_ROLES = new Set(['OWNER', 'ADMIN', 'FRONT_DESK']);

export function canViewMemberNotes(role: string | null | undefined): boolean {
  return Boolean(role && MEMBER_NOTES_READ_ROLES.has(role));
}

export function canCreateMemberNotes(role: string | null | undefined): boolean {
  return Boolean(role && MEMBER_NOTES_WRITE_ROLES.has(role));
}
