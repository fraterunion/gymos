import { normalizeStudioRole } from "@/lib/deskRoles";

/** Executive financial dashboard — OWNER and ADMIN only (matches API). */
export function canAccessExecutiveDashboard(role: string | null | undefined): boolean {
  const normalized = normalizeStudioRole(role ?? null);
  return normalized === "OWNER" || normalized === "ADMIN";
}
