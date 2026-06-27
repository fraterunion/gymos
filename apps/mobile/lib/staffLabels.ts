/** Shared read-only staff directory labels for mobile team screens. */

export type TeamDirectoryRole =
  | 'OWNER'
  | 'ADMIN'
  | 'STAFF'
  | 'INSTRUCTOR'
  | 'FRONT_DESK'
  | string;

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Propietario',
  ADMIN: 'Administrador',
  STAFF: 'Staff',
  INSTRUCTOR: 'Coach',
  FRONT_DESK: 'Recepción',
};

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  OWNER: { bg: 'rgba(245,158,11,0.18)', text: '#FCD34D' },
  ADMIN: { bg: 'rgba(139,92,246,0.18)', text: '#C4B5FD' },
  STAFF: { bg: 'rgba(20,184,166,0.18)', text: '#5EEAD4' },
  INSTRUCTOR: { bg: 'rgba(56,189,248,0.18)', text: '#7DD3FC' },
  FRONT_DESK: { bg: 'rgba(167,139,250,0.18)', text: '#DDD6FE' },
};

const DEFAULT_ROLE_COLOR = { bg: 'rgba(255,255,255,0.10)', text: '#E4E4E7' };

export function formatStaffRoleLabel(role: string | null | undefined): string {
  if (!role) return 'Staff';
  return ROLE_LABELS[role] ?? role;
}

export function getStaffRoleChipStyle(role: string | null | undefined): { bg: string; text: string } {
  if (!role) return DEFAULT_ROLE_COLOR;
  return ROLE_COLORS[role] ?? DEFAULT_ROLE_COLOR;
}

export const STAFF_TYPE_LABELS: Record<string, string> = {
  COACH: 'Coach',
  FRONT_DESK: 'Recepción',
  MANAGER: 'Gerente',
  OPERATIONS: 'Operaciones',
  OTHER: 'Otro',
};

export function formatStaffType(staffType: string | undefined | null): string {
  if (!staffType) return '—';
  return STAFF_TYPE_LABELS[staffType] ?? staffType;
}
