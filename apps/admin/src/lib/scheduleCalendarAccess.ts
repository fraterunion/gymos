/** Calendar 2.2 bulk/destructive schedule operations — OWNER/ADMIN only (API enforced). */
export function canManageCalendarOperations(
  role: string | null | undefined,
): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Calendar 2.4 series mutations — OWNER/ADMIN only (API enforced). */
export function canManageSeries(role: string | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Calendar 2.4 series read — OWNER/ADMIN/STAFF (API enforced). */
export function canViewSeries(role: string | null | undefined): boolean {
  const r = role ?? '';
  return r === 'OWNER' || r === 'ADMIN' || r === 'STAFF';
}
