import { canManageCalendarOperations } from "@/lib/scheduleCalendarAccess";
import { canRegisterManualAttendance } from "@/lib/deskRoles";

/** Manual booking from session drawer — matches API OWNER/ADMIN/STAFF. */
export function canAddMemberToSession(role: string | null | undefined): boolean {
  const r = role ?? "";
  return r === "OWNER" || r === "ADMIN" || r === "STAFF";
}

/** Booking check-in from drawer — same desk roles as members API. */
export function canCheckInFromSession(role: string | null | undefined): boolean {
  return canAddMemberToSession(role);
}

export function canEditSessionFromDrawer(role: string | null | undefined): boolean {
  return role === "OWNER" || role === "ADMIN" || role === "STAFF";
}

export function canDuplicateSessionFromDrawer(role: string | null | undefined): boolean {
  return canManageCalendarOperations(role);
}

export function canCancelSessionFromDrawer(role: string | null | undefined): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function canRegisterWalkInAttendance(role: string | null | undefined): boolean {
  return canRegisterManualAttendance(role);
}
