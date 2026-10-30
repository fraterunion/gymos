import type { MemberListItem, MemberProfile } from "@/lib/api/members";

/**
 * Member 360 → Ventas handoff ("Asignar membresía" for a member without a membership).
 *
 * The URL carries only the member's user id and is never trusted on its own: the sales page
 * re-reads the member through the SELECTED studio's scoped endpoint
 * (GET /studios/:studioId/members/:userId — studio guard + 404 outside that studio), and only a
 * MEMBER profile whose id matches the request is preselected. Anything else leaves the operator
 * on the normal search step. Membership creation itself stays in the existing sales flow.
 */
export const SALES_MEMBER_PARAM = "member";

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function salesHrefForMember(userId: string): string {
  return `/sales?${SALES_MEMBER_PARAM}=${encodeURIComponent(userId)}`;
}

/** The requested user id, or null when absent or not an id (never sent to the API then). */
export function parseSalesMemberParam(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? "";
  return USER_ID_PATTERN.test(value) ? value : null;
}

/** The sales flow's member row, built from the studio-scoped profile; null unless it is the requested MEMBER. */
export function salesMemberFromProfile(profile: MemberProfile, requestedUserId: string): MemberListItem | null {
  if (profile.role !== "MEMBER" || profile.user.id !== requestedUserId) return null;
  return {
    membershipId: profile.membership.id,
    userId: profile.user.id,
    role: "MEMBER",
    joinedAt: profile.membership.createdAt,
    user: profile.user,
    totalBookings: profile.bookingStats.totalBookings,
    noShowCount: profile.bookingStats.noShowCount,
    lastAttendanceAt: null,
    nextBooking: null,
    usage: null,
    lastPayment: null,
    attention: null,
    subscription: null,
  };
}
