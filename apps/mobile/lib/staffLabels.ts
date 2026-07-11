/** Shared read-only staff directory labels for mobile team screens. */

export type TeamDirectoryRole =
  | 'OWNER'
  | 'ADMIN'
  | 'STAFF'
  | 'INSTRUCTOR'
  | 'FRONT_DESK'
  | string;

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Dueño',
  ADMIN: 'Administrador',
  STAFF: 'Staff',
  INSTRUCTOR: 'Coach',
  FRONT_DESK: 'Recepción',
};

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  OWNER: { bg: 'rgba(91,92,235,0.16)', text: '#A5A6F6' },
  ADMIN: { bg: 'rgba(91,92,235,0.12)', text: '#8B8CF0' },
  STAFF: { bg: 'rgba(255,255,255,0.08)', text: 'rgba(255,255,255,0.72)' },
  INSTRUCTOR: { bg: 'rgba(255,255,255,0.08)', text: 'rgba(255,255,255,0.72)' },
  FRONT_DESK: { bg: 'rgba(255,255,255,0.08)', text: 'rgba(255,255,255,0.72)' },
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
