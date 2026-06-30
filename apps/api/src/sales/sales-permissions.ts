import { Role } from '@prisma/client';
import type { StudioSalesSettings } from '@prisma/client';

export type SalesSettingsView = {
  frontDeskCanCreateMember: boolean;
  frontDeskCanIssueCheckout: boolean;
  frontDeskCanRecordCash: boolean;
};

export const SALES_STAFF_ROLES: Role[] = [Role.OWNER, Role.ADMIN, Role.FRONT_DESK];

export function resolveSalesSettings(
  row: StudioSalesSettings | null,
): SalesSettingsView {
  return {
    frontDeskCanCreateMember: row?.frontDeskCanCreateMember ?? true,
    frontDeskCanIssueCheckout: row?.frontDeskCanIssueCheckout ?? true,
    frontDeskCanRecordCash: row?.frontDeskCanRecordCash ?? false,
  };
}

export function canCreateWalkInMember(
  actorRole: Role,
  settings: SalesSettingsView,
): boolean {
  if (actorRole === Role.OWNER || actorRole === Role.ADMIN) return true;
  if (actorRole === Role.FRONT_DESK) return settings.frontDeskCanCreateMember;
  return false;
}

export function canIssueStaffCheckout(
  actorRole: Role,
  settings: SalesSettingsView,
): boolean {
  if (actorRole === Role.OWNER || actorRole === Role.ADMIN) return true;
  if (actorRole === Role.FRONT_DESK) return settings.frontDeskCanIssueCheckout;
  return false;
}

export function canRecordCashPayment(
  actorRole: Role,
  settings: SalesSettingsView,
): boolean {
  if (actorRole === Role.OWNER || actorRole === Role.ADMIN) return true;
  if (actorRole === Role.FRONT_DESK) return settings.frontDeskCanRecordCash;
  return false;
}
