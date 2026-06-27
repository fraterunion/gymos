/**
 * Staff Mode role gating — mirrors API desk roles.
 * POST /studios/:studioId/check-ins/qr: FRONT_DESK | STAFF | INSTRUCTOR | ADMIN | OWNER
 * POST /studios/:studioId/check-ins/manual: FRONT_DESK | STAFF | ADMIN | OWNER
 */

export type StaffRole = 'STAFF' | 'INSTRUCTOR' | 'ADMIN' | 'OWNER';
export type DeskStaffRole = StaffRole | 'FRONT_DESK';

/** Roles that use the staff shell instead of member tabs. */
export const STAFF_SHELL_ROLES = new Set<string>([
  'FRONT_DESK',
  'STAFF',
  'INSTRUCTOR',
  'ADMIN',
  'OWNER',
]);

/** @deprecated Prefer STAFF_SHELL_ROLES — kept for existing imports. */
export const STAFF_ROLES = STAFF_SHELL_ROLES;

export function isFrontDeskRole(role: string | null | undefined): boolean {
  return role === 'FRONT_DESK';
}

export function isStaffRole(role: string | null | undefined): boolean {
  return Boolean(role && STAFF_SHELL_ROLES.has(role));
}

/** Manual check-in is FRONT_DESK | STAFF | ADMIN | OWNER (not INSTRUCTOR). */
const MANUAL_CHECK_IN_ROLES = new Set<string>(['FRONT_DESK', 'STAFF', 'ADMIN', 'OWNER']);

export function canManualCheckIn(role: string | null | undefined): boolean {
  return Boolean(role && MANUAL_CHECK_IN_ROLES.has(role));
}

/** QR scan tab is FRONT_DESK | STAFF | ADMIN | OWNER (not INSTRUCTOR). */
export function canAccessStaffScan(role: string | null | undefined): boolean {
  return Boolean(role && MANUAL_CHECK_IN_ROLES.has(role));
}

/** Team directory tab is ADMIN | OWNER only. */
const TEAM_TAB_ROLES = new Set<string>(['ADMIN', 'OWNER']);

export function canAccessTeamTab(role: string | null | undefined): boolean {
  return Boolean(role && TEAM_TAB_ROLES.has(role));
}

export function staffTabsInitialRoute(role: string | null | undefined): 'today' | 'scan' {
  if (isFrontDeskRole(role)) return 'today';
  return canAccessStaffScan(role) ? 'scan' : 'today';
}

export function staffModeTitle(role: string | null | undefined): string {
  switch (role) {
    case 'FRONT_DESK':
      return 'Recepción';
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
  if (role === 'FRONT_DESK') {
    return 'Consulta las clases de hoy y realiza check-in.';
  }
  if (role === 'INSTRUCTOR') {
    return 'Consulta las clases y asistencia de hoy.';
  }
  return 'Supervisa las clases y asistencia de hoy.';
}
