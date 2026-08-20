import type { SubscriptionSource } from '@prisma/client';
import type { MembershipLifecycleStatus } from '../memberships/membership-entitlement';

export type MemberLifecycleFilter = MembershipLifecycleStatus | 'NONE';
export type MemberActivityFilter =
  | 'VISITED_7D' | 'VISITED_30D' | 'NO_VISIT_14D' | 'NO_VISIT_30D'
  | 'NEVER_ATTENDED' | 'HAS_NO_SHOWS' | 'HAS_FUTURE_BOOKING'
  | 'NO_FUTURE_BOOKING' | 'ENDING_7D';

export type MemberPrimaryStatus = Exclude<MembershipLifecycleStatus, 'ENDING'>;
export type MemberAttentionCode =
  | 'PAST_DUE' | 'EXPIRED' | 'WAIVER' | 'ZERO_CREDITS' | 'ENDING_SOON'
  | 'NO_SHOWS' | 'INACTIVE';

export type MemberAttention = {
  code: MemberAttentionCode;
  label: string;
  action: 'REVIEW_BILLING' | 'RENEW' | null;
} | null;

export function toPrimaryMembershipStatus(status: MembershipLifecycleStatus): MemberPrimaryStatus {
  return status === 'ENDING' ? 'ACTIVE' : status;
}

export function matchesLifecycleFilter(status: MembershipLifecycleStatus | null, filter?: MemberLifecycleFilter): boolean {
  if (!filter) return true;
  if (filter === 'NONE') return status === null;
  if (filter === 'ACTIVE') return status === 'ACTIVE' || status === 'ENDING';
  return status === filter;
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

export function selectHighestMemberAttention(
  member: {
    lifecycleStatus: MembershipLifecycleStatus | null;
    effectiveEnd: Date | null;
    creditsRemaining: number | null;
    waiverPending?: boolean;
    noShowCount: number;
    lastAttendanceAt: Date | null;
  },
  now: Date,
): MemberAttention {
  if (member.lifecycleStatus === 'PAST_DUE') return { code: 'PAST_DUE', label: 'Cobro pendiente', action: 'REVIEW_BILLING' };
  if (member.lifecycleStatus === 'EXPIRED') return { code: 'EXPIRED', label: 'Renovar', action: 'RENEW' };
  if (member.waiverPending) return { code: 'WAIVER', label: 'Carta pendiente', action: null };
  if (member.creditsRemaining === 0) return { code: 'ZERO_CREDITS', label: 'Sin créditos', action: 'RENEW' };
  if (member.lifecycleStatus === 'ENDING' && member.effectiveEnd && member.effectiveEnd <= new Date(now.getTime() + 7 * 86_400_000)) {
    return { code: 'ENDING_SOON', label: 'Próxima a vencer', action: 'RENEW' };
  }
  if (member.noShowCount > 0) return { code: 'NO_SHOWS', label: `${member.noShowCount} no-show${member.noShowCount === 1 ? '' : 's'}`, action: null };
  if (!member.lastAttendanceAt) return { code: 'INACTIVE', label: 'Sin actividad', action: null };
  const inactiveDays = Math.floor((now.getTime() - member.lastAttendanceAt.getTime()) / 86_400_000);
  if (inactiveDays >= 14) return { code: 'INACTIVE', label: `Sin actividad ${inactiveDays}d`, action: null };
  return null;
}
