export type DeskStudioRole =
  | "OWNER"
  | "ADMIN"
  | "STAFF"
  | "INSTRUCTOR"
  | "FRONT_DESK"
  | "MEMBER"
  | string;

export function isFrontDeskRole(role: string | undefined | null): boolean {
  return role === "FRONT_DESK";
}

/** Routes reception staff may access in the admin desk app. */
export function isFrontDeskAllowedPath(pathname: string): boolean {
  return pathname === "/scan" || pathname === "/check-in" || pathname.startsWith("/check-in/");
}

export function canManageStudioSettings(role: string | undefined | null): boolean {
  return role === "OWNER" || role === "ADMIN";
}
