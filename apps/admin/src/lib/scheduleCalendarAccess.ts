/** Calendar 2.2 bulk/destructive schedule operations — OWNER/ADMIN only (API enforced). */
export function canManageCalendarOperations(
  role: string | null | undefined,
): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}
