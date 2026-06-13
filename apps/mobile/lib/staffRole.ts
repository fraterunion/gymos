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

/** QR scan tab is STAFF | ADMIN | OWNER only (not INSTRUCTOR). */
export function canAccessStaffScan(role: string | null | undefined): boolean {
  return Boolean(role && MANUAL_CHECK_IN_ROLES.has(role));
}

export function staffModeTitle(role: string | null | undefined): string {
  switch (role) {
    case 'INSTRUCTOR':
      return 'Coach Mode';
    case 'ADMIN':
      return 'Admin Mode';
    case 'OWNER':
      return 'Owner Mode';
    case 'STAFF':
    default:
      return 'Staff Mode';
  }
}

export function todayScreenSubtitle(role: string | null | undefined): string {
  if (role === 'INSTRUCTOR') {
    return "View today's classes and attendance.";
  }
  return "Monitor today's classes and attendance.";
}
