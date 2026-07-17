export type DeskStudioRole =
  | "OWNER"
  | "ADMIN"
  | "STAFF"
  | "INSTRUCTOR"
  | "FRONT_DESK"
  | "MEMBER"
  | string;

export function normalizeStudioRole(role: string | undefined | null): string | null {
  if (role == null) return null;
  const trimmed = String(role).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isFrontDeskRole(role: string | undefined | null): boolean {
  return normalizeStudioRole(role) === "FRONT_DESK";
}

/** Routes reception staff may access in the admin desk app. */
export function isFrontDeskAllowedPath(pathname: string): boolean {
  return (
    pathname === "/scan" ||
    pathname === "/check-in" ||
    pathname === "/sales" ||
    pathname.startsWith("/check-in/")
  );
}

export function canAccessWalkInSales(role: string | undefined | null): boolean {
  const normalized = normalizeStudioRole(role);
  return (
    normalized === "OWNER" ||
    normalized === "ADMIN" ||
    normalized === "FRONT_DESK"
  );
}

export function canRecordCashSales(
  role: string | undefined | null,
  settings?: { frontDeskCanRecordCash?: boolean },
): boolean {
  const normalized = normalizeStudioRole(role);
  if (normalized === "OWNER" || normalized === "ADMIN") return true;
  if (normalized === "FRONT_DESK") return settings?.frontDeskCanRecordCash === true;
  return false;
}

export function canManageStudioSettings(role: string | undefined | null): boolean {
  const normalized = normalizeStudioRole(role);
  return normalized === "OWNER" || normalized === "ADMIN";
}

/** Walk-in class attendance without a reservation — OWNER, ADMIN, FRONT_DESK only. */
export function canRegisterManualAttendance(role: string | undefined | null): boolean {
  const normalized = normalizeStudioRole(role);
  return normalized === "OWNER" || normalized === "ADMIN" || normalized === "FRONT_DESK";
}
