import type { SalesSettings } from '@/lib/api/salesApi';

export const SALES_STAFF_ROLES = new Set(['OWNER', 'ADMIN', 'FRONT_DESK']);

export function canAccessSales(role: string | null | undefined): boolean {
  return Boolean(role && SALES_STAFF_ROLES.has(role));
}

export function canCreateWalkInMember(
  role: string | null | undefined,
  settings?: SalesSettings | null,
): boolean {
  if (role === 'OWNER' || role === 'ADMIN') return true;
  if (role === 'FRONT_DESK') return settings?.frontDeskCanCreateMember !== false;
  return false;
}

export function canIssueStaffCheckout(
  role: string | null | undefined,
  settings?: SalesSettings | null,
): boolean {
  if (role === 'OWNER' || role === 'ADMIN') return true;
  if (role === 'FRONT_DESK') return settings?.frontDeskCanIssueCheckout !== false;
  return false;
}

export function canRecordCashSales(
  role: string | null | undefined,
  settings?: SalesSettings | null,
): boolean {
  if (role === 'OWNER' || role === 'ADMIN') return true;
  if (role === 'FRONT_DESK') return settings?.frontDeskCanRecordCash === true;
  return false;
}
