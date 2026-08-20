import { BookingStatus } from '@prisma/client';
import { buildAttendanceRate, buildBookingSummary, buildMemberEngagement, isCurrentImmutableCycle, sortMemberTimeline } from './member-360.utils';

describe('Member 360 operational summaries', () => {
  it('computes deterministic current-period and 30-day engagement without a churn score', () => {
    expect(buildMemberEngagement({ visitsCurrentPeriod: 8, visitsLast30Days: 10, daysSinceLastVisit: 2 })).toEqual({
      visitsCurrentPeriod: 8,
      visitsLast30Days: 10,
      daysSinceLastVisit: 2,
      averageVisitsPerWeekLast30: 2.3,
    });
  });

  it('builds booking summary counts and defaults missing states to zero', () => {
    expect(buildBookingSummary([
      { status: BookingStatus.COMPLETED, _count: { _all: 8 } },
      { status: BookingStatus.CANCELLED, _count: { _all: 2 } },
      { status: BookingStatus.NO_SHOW, _count: { _all: 1 } },
    ], 3)).toEqual({ upcoming: 3, completed: 8, cancelled: 2, noShows: 1 });
  });

  it('calculates attendance from completed attendance outcomes, excluding cancellations and future bookings', () => {
    expect(buildAttendanceRate(8, 2)).toBe(80);
    expect(buildAttendanceRate(0, 0)).toBeNull();
  });

  it('recognizes only a current immutable cycle and never invents a future one', () => {
    const now = new Date('2026-08-20T00:00:00Z');
    expect(isCurrentImmutableCycle({ startsAt: new Date('2026-08-18'), endsAt: new Date('2026-10-02') }, now)).toBe(true);
    expect(isCurrentImmutableCycle({ startsAt: new Date('2026-10-02'), endsAt: new Date('2026-11-16') }, now)).toBe(false);
    expect(isCurrentImmutableCycle({ startsAt: new Date('2026-07-01'), endsAt: now }, now)).toBe(false);
  });

  it('orders real timeline events newest first while retaining optional actors', () => {
    const events = [
      { type: 'PAYMENT', actor: null, occurredAt: new Date('2026-08-18') },
      { type: 'ATTENDANCE', actor: 'Front Desk', occurredAt: new Date('2026-08-20') },
      { type: 'MEMBERSHIP', actor: null, occurredAt: new Date('2026-08-19') },
    ];
    expect(sortMemberTimeline(events).map((event) => event.type)).toEqual(['ATTENDANCE', 'MEMBERSHIP', 'PAYMENT']);
    expect(sortMemberTimeline(events)[0]?.actor).toBe('Front Desk');
  });
});
