import { SubscriptionSource } from '@prisma/client';
import { matchesActivityFilter, matchesLifecycleFilter, matchesPaymentSource, selectHighestMemberAttention, toPrimaryMembershipStatus } from './member-operations';

describe('member operations directory filters', () => {
  const now = new Date('2026-08-20T00:00:00.000Z');
  const base = { lastAttendanceAt: new Date('2026-08-18T00:00:00.000Z'), noShowCount: 0, hasFutureBooking: false, lifecycleStatus: 'ACTIVE' as const, effectiveEnd: new Date('2026-09-01T00:00:00.000Z') };

  it.each(['ACTIVE', 'ENDING', 'EXPIRED', 'TRIALING', 'PAST_DUE', 'PAUSED', 'CANCELED', 'SCHEDULED'] as const)('filters derived lifecycle %s without consulting raw status', (status) => {
    expect(matchesLifecycleFilter(status, status)).toBe(true);
    expect(matchesLifecycleFilter(status, status === 'ACTIVE' ? 'EXPIRED' : 'ACTIVE')).toBe(status === 'ENDING');
  });
  it('filters no-membership independently', () => {
    expect(matchesLifecycleFilter(null, 'NONE')).toBe(true);
    expect(matchesLifecycleFilter('EXPIRED', 'NONE')).toBe(false);
  });
  it('keeps expired raw-ACTIVE members out of the Active segment by consuming derived state', () => {
    expect(matchesLifecycleFilter('EXPIRED', 'ACTIVE')).toBe(false);
    expect(matchesLifecycleFilter('EXPIRED', 'EXPIRED')).toBe(true);
  });
  it('presents entitled ENDING as primary ACTIVE while retaining the ending-soon segment', () => {
    expect(toPrimaryMembershipStatus('ENDING')).toBe('ACTIVE');
    expect(matchesLifecycleFilter('ENDING', 'ACTIVE')).toBe(true);
    expect(matchesActivityFilter({ ...base, lifecycleStatus: 'ENDING', effectiveEnd: new Date('2026-08-25') }, 'ENDING_7D', now)).toBe(true);
  });
  it('presents provider TRIALING as ACTIVE only with a current paid entitlement cycle', () => {
    expect(toPrimaryMembershipStatus('TRIALING', { isEntitled: true, hasCurrentPaidEntitlementCycle: true })).toBe('ACTIVE');
    expect(toPrimaryMembershipStatus('TRIALING', { isEntitled: true, hasCurrentPaidEntitlementCycle: false })).toBe('TRIALING');
    expect(matchesLifecycleFilter('ACTIVE', 'ACTIVE')).toBe(true);
    expect(matchesLifecycleFilter('ACTIVE', 'TRIALING')).toBe(false);
  });
  it('preserves ordinary active and expired operational states', () => {
    expect(toPrimaryMembershipStatus('ACTIVE', { isEntitled: true, hasCurrentPaidEntitlementCycle: true })).toBe('ACTIVE');
    expect(toPrimaryMembershipStatus('EXPIRED', { isEntitled: false, hasCurrentPaidEntitlementCycle: true })).toBe('EXPIRED');
  });
  it.each([SubscriptionSource.STRIPE, SubscriptionSource.CASH, SubscriptionSource.MANUAL])('filters payment source %s', (source) => {
    expect(matchesPaymentSource(source, source)).toBe(true);
    expect(matchesPaymentSource(source, 'NONE')).toBe(false);
  });
  it('filters members with no payment source', () => expect(matchesPaymentSource(null, 'NONE')).toBe(true));
  it('supports recent visit windows', () => {
    expect(matchesActivityFilter(base, 'VISITED_7D', now)).toBe(true);
    expect(matchesActivityFilter(base, 'VISITED_30D', now)).toBe(true);
  });
  it('supports inactivity and never-attended segments', () => {
    expect(matchesActivityFilter({ ...base, lastAttendanceAt: new Date('2026-07-01') }, 'NO_VISIT_30D', now)).toBe(true);
    expect(matchesActivityFilter({ ...base, lastAttendanceAt: null }, 'NEVER_ATTENDED', now)).toBe(true);
  });
  it('supports no-show and future-booking filters', () => {
    expect(matchesActivityFilter({ ...base, noShowCount: 2 }, 'HAS_NO_SHOWS', now)).toBe(true);
    expect(matchesActivityFilter({ ...base, hasFutureBooking: true }, 'HAS_FUTURE_BOOKING', now)).toBe(true);
    expect(matchesActivityFilter(base, 'NO_FUTURE_BOOKING', now)).toBe(true);
  });
  it('matches only ending memberships inside seven days', () => {
    expect(matchesActivityFilter({ ...base, lifecycleStatus: 'ENDING', effectiveEnd: new Date('2026-08-25') }, 'ENDING_7D', now)).toBe(true);
    expect(matchesActivityFilter({ ...base, lifecycleStatus: 'ACTIVE' }, 'ENDING_7D', now)).toBe(false);
  });

  it('selects attention deterministically by operational priority', () => {
    expect(selectHighestMemberAttention({ lifecycleStatus: 'PAST_DUE', effectiveEnd: null, creditsRemaining: 0, noShowCount: 3, lastAttendanceAt: null }, now)?.code).toBe('PAST_DUE');
    expect(selectHighestMemberAttention({ lifecycleStatus: 'EXPIRED', effectiveEnd: new Date('2026-08-01'), creditsRemaining: 4, noShowCount: 2, lastAttendanceAt: null }, now)).toMatchObject({ code: 'EXPIRED', label: 'Renovar' });
    expect(selectHighestMemberAttention({ lifecycleStatus: 'ACTIVE', effectiveEnd: new Date('2026-09-01'), creditsRemaining: 0, waiverPending: true, noShowCount: 2, lastAttendanceAt: null }, now)?.code).toBe('WAIVER');
    expect(selectHighestMemberAttention({ lifecycleStatus: 'ENDING', effectiveEnd: new Date('2026-08-25'), creditsRemaining: 1, noShowCount: 2, lastAttendanceAt: null }, now)?.code).toBe('ENDING_SOON');
    expect(selectHighestMemberAttention({ lifecycleStatus: 'ENDING', effectiveEnd: new Date('2026-10-02'), creditsRemaining: 1, noShowCount: 0, lastAttendanceAt: new Date('2026-08-18') }, now)).toBeNull();
  });

  it('uses credit, no-show and inactivity fallbacks and leaves healthy members clear', () => {
    expect(selectHighestMemberAttention({ ...base, creditsRemaining: 0 }, now)?.code).toBe('ZERO_CREDITS');
    expect(selectHighestMemberAttention({ ...base, creditsRemaining: 2, noShowCount: 2 }, now)?.code).toBe('NO_SHOWS');
    expect(selectHighestMemberAttention({ ...base, creditsRemaining: 2, lastAttendanceAt: new Date('2026-07-01') }, now)?.code).toBe('INACTIVE');
    expect(selectHighestMemberAttention({ ...base, creditsRemaining: 2 }, now)).toBeNull();
  });
});
