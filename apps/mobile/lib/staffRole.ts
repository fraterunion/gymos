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

/** Team directory tab is ADMIN | OWNER only. */
const TEAM_TAB_ROLES = new Set<string>(['ADMIN', 'OWNER']);

export function canAccessTeamTab(role: string | null | undefined): boolean {
  return Boolean(role && TEAM_TAB_ROLES.has(role));
}

export function staffModeTitle(role: string | null | undefined): string {
  switch (role) {
    case 'INSTRUCTOR':
      return 'Modo coach';
    case 'ADMIN':
      return 'Modo admin';
    case 'OWNER':
      return 'Modo propietario';
    case 'STAFF':
    default:
      return 'Modo staff';
  }
}

export function todayScreenSubtitle(role: string | null | undefined): string {
  if (role === 'INSTRUCTOR') {
    return 'Consulta las clases y asistencia de hoy.';
  }
  return 'Supervisa las clases y asistencia de hoy.';
}
