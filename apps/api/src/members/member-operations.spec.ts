import { SubscriptionSource } from '@prisma/client';
import { matchesActivityFilter, matchesLifecycleFilter, matchesPaymentSource } from './member-operations';

describe('member operations directory filters', () => {
  const now = new Date('2026-08-20T00:00:00.000Z');
  const base = { lastAttendanceAt: new Date('2026-08-18T00:00:00.000Z'), noShowCount: 0, hasFutureBooking: false, lifecycleStatus: 'ACTIVE' as const, effectiveEnd: new Date('2026-09-01T00:00:00.000Z') };

  it.each(['ACTIVE', 'ENDING', 'EXPIRED', 'TRIALING', 'PAST_DUE', 'PAUSED', 'CANCELED', 'SCHEDULED'] as const)('filters derived lifecycle %s without consulting raw status', (status) => {
    expect(matchesLifecycleFilter(status, status)).toBe(true);
    expect(matchesLifecycleFilter(status, status === 'ACTIVE' ? 'EXPIRED' : 'ACTIVE')).toBe(false);
  });
  it('filters no-membership independently', () => {
    expect(matchesLifecycleFilter(null, 'NONE')).toBe(true);
    expect(matchesLifecycleFilter('EXPIRED', 'NONE')).toBe(false);
  });
  it('keeps expired raw-ACTIVE members out of the Active segment by consuming derived state', () => {
    expect(matchesLifecycleFilter('EXPIRED', 'ACTIVE')).toBe(false);
    expect(matchesLifecycleFilter('EXPIRED', 'EXPIRED')).toBe(true);
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
});
