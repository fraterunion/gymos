/**
 * Staff Mode role gating — mirrors the API guard on
 * POST /studios/:studioId/check-ins/qr (STAFF | INSTRUCTOR | ADMIN | OWNER).
 */

export type StaffRole = 'STAFF' | 'INSTRUCTOR' | 'ADMIN' | 'OWNER';

export const STAFF_ROLES = new Set<string>(['STAFF', 'INSTRUCTOR', 'ADMIN', 'OWNER']);

export function isStaffRole(role: string | null | undefined): boolean {
  return Boolean(role && STAFF_ROLES.has(role));
}

/** Manual check-in is STAFF | ADMIN | OWNER only (not INSTRUCTOR). */
const MANUAL_CHECK_IN_ROLES = new Set<string>(['STAFF', 'ADMIN', 'OWNER']);

export function canManualCheckIn(role: string | null | undefined): boolean {
  return Boolean(role && MANUAL_CHECK_IN_ROLES.has(role));
}
