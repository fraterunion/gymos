import type { StaffRole } from '@/lib/api/staffApi';

export type StaffType = 'COACH' | 'FRONT_DESK' | 'MANAGER' | 'OPERATIONS' | 'OTHER';

export const STAFF_TYPE_OPTIONS: { value: StaffType; label: string }[] = [
  { value: 'COACH', label: 'Coach' },
  { value: 'FRONT_DESK', label: 'Recepción' },
  { value: 'MANAGER', label: 'Gerente' },
  { value: 'OPERATIONS', label: 'Operaciones' },
  { value: 'OTHER', label: 'Otro' },
];

export const ALL_ASSIGNABLE_ROLES: StaffRole[] = [
  'OWNER',
  'ADMIN',
  'STAFF',
  'INSTRUCTOR',
  'FRONT_DESK',
];

export function assignableRolesForActor(actorRole: string | null | undefined): StaffRole[] {
  if (actorRole === 'OWNER') return ALL_ASSIGNABLE_ROLES;
  if (actorRole === 'ADMIN') return ['ADMIN', 'STAFF', 'INSTRUCTOR', 'FRONT_DESK'];
  return [];
}

export function canActorManageTarget(
  actorRole: string | null | undefined,
  targetRole: StaffRole,
): boolean {
  if (actorRole === 'OWNER') return true;
  if (actorRole === 'ADMIN') return targetRole !== 'OWNER';
  return false;
}

export function defaultStaffTypeForRole(role: StaffRole): StaffType {
  if (role === 'OWNER') return 'MANAGER';
  if (role === 'INSTRUCTOR') return 'COACH';
  if (role === 'FRONT_DESK') return 'FRONT_DESK';
  if (role === 'ADMIN') return 'MANAGER';
  return 'OTHER';
}

export function validatePassword(password: string): string | null {
  const trimmed = password.trim();
  if (trimmed.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (trimmed.length > 128) return 'La contraseña no puede superar 128 caracteres.';
  return null;
}
