import type { SubscriptionSource } from '@prisma/client';
import type { MembershipLifecycleStatus } from '../memberships/membership-entitlement';

export type MemberLifecycleFilter = MembershipLifecycleStatus | 'NONE';
export type MemberActivityFilter =
  | 'VISITED_7D' | 'VISITED_30D' | 'NO_VISIT_14D' | 'NO_VISIT_30D'
  | 'NEVER_ATTENDED' | 'HAS_NO_SHOWS' | 'HAS_FUTURE_BOOKING'
  | 'NO_FUTURE_BOOKING' | 'ENDING_7D';

export function matchesLifecycleFilter(status: MembershipLifecycleStatus | null, filter?: MemberLifecycleFilter): boolean {
  if (!filter) return true;
  return filter === 'NONE' ? status === null : status === filter;
}

export function matchesPaymentSource(source: SubscriptionSource | null, filter?: SubscriptionSource | 'NONE'): boolean {
  if (!filter) return true;
  return filter === 'NONE' ? source === null : source === filter;
}

export function matchesActivityFilter(
  member: { lastAttendanceAt: Date | null; noShowCount: number; hasFutureBooking: boolean; lifecycleStatus: MembershipLifecycleStatus | null; effectiveEnd: Date | null },
  filter: MemberActivityFilter | undefined,
  now: Date,
): boolean {
  if (!filter) return true;
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  if (filter === 'VISITED_7D') return !!member.lastAttendanceAt && member.lastAttendanceAt >= daysAgo(7);
  if (filter === 'VISITED_30D') return !!member.lastAttendanceAt && member.lastAttendanceAt >= daysAgo(30);
  if (filter === 'NO_VISIT_14D') return !member.lastAttendanceAt || member.lastAttendanceAt < daysAgo(14);
  if (filter === 'NO_VISIT_30D') return !member.lastAttendanceAt || member.lastAttendanceAt < daysAgo(30);
  if (filter === 'NEVER_ATTENDED') return member.lastAttendanceAt === null;
  if (filter === 'HAS_NO_SHOWS') return member.noShowCount > 0;
  if (filter === 'HAS_FUTURE_BOOKING') return member.hasFutureBooking;
  if (filter === 'NO_FUTURE_BOOKING') return !member.hasFutureBooking;
  return member.lifecycleStatus === 'ENDING' && !!member.effectiveEnd && member.effectiveEnd <= new Date(now.getTime() + 7 * 86_400_000);
}
