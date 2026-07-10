import { Prisma, Role } from '@prisma/client';

/**
 * Owner-facing Analytics excludes studio memberships flagged for App Review /
 * internal test accounts. Financial queries are unchanged unless they join users.
 * Coach/class metrics never filter instructors by this flag.
 */

export function analyticsMembershipWhere(studioId: string) {
  return {
    studioId,
    excludeFromAnalytics: false,
    deletedAt: null,
    user: { deletedAt: null },
  };
}

export function analyticsMemberMembershipWhere(studioId: string) {
  return {
    ...analyticsMembershipWhere(studioId),
    role: Role.MEMBER,
  };
}

export function analyticsIncludedUserFilter(studioId: string): Prisma.UserWhereInput {
  return {
    studioMemberships: {
      some: {
        studioId,
        excludeFromAnalytics: false,
      },
    },
  };
}

export function analyticsExcludedSubscriptionFilter(
  studioId: string,
): Prisma.SubscriptionWhereInput {
  return {
    studioId,
    user: analyticsIncludedUserFilter(studioId),
  };
}

/** SQL fragment — bookings alias must be `b`. */
export const SQL_BOOKING_EXCLUDE = Prisma.sql`
  AND NOT EXISTS (
    SELECT 1 FROM studio_memberships sm_ex
    WHERE sm_ex.studio_id = b.studio_id
      AND sm_ex.user_id = b.user_id
      AND sm_ex.exclude_from_analytics = true
  )
`;

/** SQL fragment — attendances alias must be `a`. */
export const SQL_ATTENDANCE_EXCLUDE = Prisma.sql`
  AND NOT EXISTS (
    SELECT 1 FROM studio_memberships sm_ex
    WHERE sm_ex.studio_id = a.studio_id
      AND sm_ex.user_id = a.user_id
      AND sm_ex.exclude_from_analytics = true
  )
`;

/** SQL fragment — studio_memberships alias must be `sm`. */
export const SQL_MEMBERSHIP_ROW_INCLUDE = Prisma.sql`AND sm.exclude_from_analytics = false`;

/** SQL fragment — subscriptions alias must be `s`. */
export const SQL_SUBSCRIPTION_USER_EXCLUDE = Prisma.sql`
  AND NOT EXISTS (
    SELECT 1 FROM studio_memberships sm_ex
    WHERE sm_ex.studio_id = s.studio_id
      AND sm_ex.user_id = s.user_id
      AND sm_ex.exclude_from_analytics = true
  )
`;
