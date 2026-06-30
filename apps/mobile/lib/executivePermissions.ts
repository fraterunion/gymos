/**
 * Executive dashboard — mirrors API analytics access intent for owner/operators.
 * GET /studios/:studioId/analytics/* allows OWNER, ADMIN, STAFF on the API;
 * mobile exposes the cockpit UI to OWNER and ADMIN only.
 */
export const EXECUTIVE_DASHBOARD_ROLES = new Set(['OWNER', 'ADMIN']);

export function canAccessExecutiveDashboard(role: string | null | undefined): boolean {
  return Boolean(role && EXECUTIVE_DASHBOARD_ROLES.has(role));
}
