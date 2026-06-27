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
  return pathname === "/scan" || pathname === "/check-in" || pathname.startsWith("/check-in/");
}

export function canManageStudioSettings(role: string | undefined | null): boolean {
  const normalized = normalizeStudioRole(role);
  return normalized === "OWNER" || normalized === "ADMIN";
}
