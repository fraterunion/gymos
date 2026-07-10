import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import {
  SQL_ATTENDANCE_EXCLUDE,
  SQL_BOOKING_EXCLUDE,
  SQL_SUBSCRIPTION_USER_EXCLUDE,
} from './analytics-exclusion.utils';
import { AnalyticsService } from './analytics.service';

const AS_OF = new Date('2026-07-10T14:00:00.000Z');
const STUDIO_A = 'studio-a';
const STUDIO_B = 'studio-b';

function sql(strings: TemplateStringsArray): string {
  return strings.join(' ');
}

function createExclusionPrismaMock() {
  const membershipCount = jest.fn().mockResolvedValue(10);
  const attendanceCount = jest.fn().mockResolvedValue(5);
  const bookingCount = jest.fn().mockResolvedValue(3);

  const queryRaw = jest.fn().mockImplementation((strings: TemplateStringsArray) => {
    const q = sql(strings);

    if (q.includes('COUNT(DISTINCT sc.id)')) {
      return Promise.resolve([
        {
          id: 'coach-ares',
          first_name: 'Yayo',
          last_name: 'Coach',
          class_count: 30n,
        },
      ]);
    }
    if (q.includes('no_show')) {
      return Promise.resolve([{ no_show: 0n, total: 0n }]);
    }
    if (q.includes('booking_count') && q.includes('class_templates')) {
      return Promise.resolve([]);
    }
    if (q.includes('date_trunc') && q.includes('studio_memberships')) {
      return Promise.resolve([{ d: new Date('2026-07-09T00:00:00.000Z'), count: 2n }]);
    }
    if (q.includes('HAVING COUNT(*) >= 2')) {
      return Promise.resolve([{ c: 1n }]);
    }
    if (q.includes('v.bucket')) {
      return Promise.resolve([{ bucket: '1', member_count: 2n }]);
    }
    if (q.includes('waiver_acceptances wa')) {
      return Promise.resolve([{ c: 0n }]);
    }
    if (q.includes('FROM attendances a') && q.includes('NOT EXISTS')) {
      return Promise.resolve([{ c: 1n }]);
    }
    if (q.includes('COALESCE(SUM(amount_cents), 0)::bigint AS total_cents')) {
      return Promise.resolve([{ total_cents: 425_000n }]);
    }
    if (q.includes('date_trunc') && q.includes('bookings b')) {
      return Promise.resolve([]);
    }
    if (q.includes('date_trunc') && q.includes('attendances a')) {
      return Promise.resolve([]);
    }

    return Promise.resolve([]);
  });

  const prisma = {
    studio: {
      findUnique: jest.fn().mockResolvedValue({ timezone: 'America/Mexico_City' }),
    },
    studioEnrollmentSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    studioMembership: { count: membershipCount },
    attendance: { count: attendanceCount },
    booking: { count: bookingCount },
    scheduledClass: { count: jest.fn().mockResolvedValue(0) },
    waitlistEntry: { count: jest.fn().mockResolvedValue(0) },
    subscription: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ currency: 'mxn' }),
      count: jest.fn().mockResolvedValue(0),
    },
    membershipPlan: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    memberEnrollment: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: queryRaw,
  };

  return { prisma, membershipCount, attendanceCount, bookingCount, queryRaw };
}

describe('AnalyticsService analytics exclusion', () => {
  let service: AnalyticsService;
  let membershipCount: jest.Mock;
  let attendanceCount: jest.Mock;
  let bookingCount: jest.Mock;
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(AS_OF);

    const mocks = createExclusionPrismaMock();
    membershipCount = mocks.membershipCount;
    attendanceCount = mocks.attendanceCount;
    bookingCount = mocks.bookingCount;
    queryRaw = mocks.queryRaw;

    const module: TestingModule = await Test.createTestingModule({
      providers: [AnalyticsService, { provide: PrismaService, useValue: mocks.prisma }],
    }).compile();

    service = module.get(AnalyticsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('excludes flagged memberships from new-member counts', async () => {
    await service.getBusinessAnalytics(STUDIO_A);

    const memberCalls = membershipCount.mock.calls.filter(
      (c) => c[0]?.where?.role === 'MEMBER',
    );
    expect(memberCalls.length).toBeGreaterThan(0);
    for (const call of memberCalls) {
      expect(call[0].where).toMatchObject({
        studioId: STUDIO_A,
        excludeFromAnalytics: false,
        role: 'MEMBER',
      });
    }
  });

  it('excludes flagged users from booking counts in overview', async () => {
    await service.getOverview(STUDIO_A, 30);

    expect(bookingCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          studioId: STUDIO_A,
          user: {
            studioMemberships: {
              some: { studioId: STUDIO_A, excludeFromAnalytics: false },
            },
          },
        }),
      }),
    );
  });

  it('excludes flagged users from attendance counts', async () => {
    await service.getOverview(STUDIO_A, 30);

    expect(attendanceCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          studioId: STUDIO_A,
          user: {
            studioMemberships: {
              some: { studioId: STUDIO_A, excludeFromAnalytics: false },
            },
          },
        }),
      }),
    );
  });

  it('adds SQL exclusion to booking trend and no-show queries', async () => {
    await service.getOverview(STUDIO_A, 30);

    const hasBookingExclusion = queryRaw.mock.calls.some((call) =>
      call.includes(SQL_BOOKING_EXCLUDE),
    );
    expect(hasBookingExclusion).toBe(true);
  });

  it('adds SQL exclusion to attendance trend queries', async () => {
    await service.getTrends(STUDIO_A, 30);

    const hasAttendanceExclusion = queryRaw.mock.calls.some((call) =>
      call.includes(SQL_ATTENDANCE_EXCLUDE),
    );
    expect(hasAttendanceExclusion).toBe(true);
  });

  it('keeps normal members in member-signup trend SQL', async () => {
    await service.getBusinessAnalytics(STUDIO_A);

    const signupTrend = queryRaw.mock.calls.find(
      (c) =>
        sql(c[0]).includes('FROM studio_memberships') &&
        sql(c[0]).includes('exclude_from_analytics = false'),
    );
    expect(signupTrend).toBeDefined();
  });

  it('keeps @ares.demo instructors in coach metrics without exclusion filter', async () => {
    const result = await service.getOverview(STUDIO_A, 30);

    const coachCall = queryRaw.mock.calls.find((c) =>
      sql(c[0]).includes('COUNT(DISTINCT sc.id)'),
    );
    expect(sql(coachCall![0])).not.toContain('exclude_from_analytics');
    expect(result.mostActiveCoach?.classCount).toBe(30);
  });

  it('scopes exclusion to the requested studio', async () => {
    await service.getOverview(STUDIO_B, 30);

    expect(membershipCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          studioId: STUDIO_B,
          excludeFromAnalytics: false,
        }),
      }),
    );
    expect(bookingCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          studioId: STUDIO_B,
          user: {
            studioMemberships: {
              some: { studioId: STUDIO_B, excludeFromAnalytics: false },
            },
          },
        }),
      }),
    );
  });

  it('does not filter financial payment totals by analytics exclusion', async () => {
    await service.getBusinessAnalytics(STUDIO_A);

    const paymentTotals = queryRaw.mock.calls.filter(
      (c) =>
        sql(c[0]).includes('FROM payments') &&
        sql(c[0]).includes("status = 'SUCCEEDED'"),
    );
    expect(paymentTotals.length).toBeGreaterThan(0);
    for (const call of paymentTotals) {
      expect(sql(call[0])).not.toContain('exclude_from_analytics');
    }
  });

  it('does not filter getFinancialSummary payment queries by exclusion', async () => {
    queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const q = sql(strings);
      if (q.includes('payment_count') && q.includes('stripe_cents')) {
        return Promise.resolve([
          {
            total_cents: 425_000n,
            payment_count: 3n,
            stripe_cents: 0n,
            cash_cents: 425_000n,
            other_cents: 0n,
          },
        ]);
      }
      if (q.includes('FROM payments')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    await service.getFinancialSummary(STUDIO_A, 'monthToDate');

    const financialCalls = queryRaw.mock.calls.filter((c) =>
      sql(c[0]).includes('FROM payments'),
    );
    expect(financialCalls.length).toBeGreaterThan(0);
    for (const call of financialCalls) {
      expect(call.includes(SQL_SUBSCRIPTION_USER_EXCLUDE)).toBe(false);
      expect(call.includes(SQL_BOOKING_EXCLUDE)).toBe(false);
      expect(call.includes(SQL_ATTENDANCE_EXCLUDE)).toBe(false);
    }
  });

  it('still queries memberships without exclusion filter for operational use', async () => {
    const prisma = {
      studioMembership: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'sm-review',
            excludeFromAnalytics: true,
            user: { email: 'apple.review@fraterunion.com' },
          },
        ]),
      },
    };

    const rows = await prisma.studioMembership.findMany({
      where: { studioId: STUDIO_A },
    });

    expect(rows).toHaveLength(1);
    expect(prisma.studioMembership.findMany).toHaveBeenCalledWith({
      where: { studioId: STUDIO_A },
    });
    expect(rows[0].excludeFromAnalytics).toBe(true);
  });

  it('filters paying-member subscription counts in owner briefing', async () => {
    await service.getOwnerBriefing(STUDIO_A);

    const hasSubscriptionExclusion = queryRaw.mock.calls.some((call) =>
      call.includes(SQL_SUBSCRIPTION_USER_EXCLUDE),
    );
    expect(hasSubscriptionExclusion).toBe(true);
  });

  it('still counts succeeded payments in briefing without exclusion', async () => {
    await service.getOwnerBriefing(STUDIO_A);

    const paymentCalls = queryRaw.mock.calls.filter(
      (c) =>
        sql(c[0]).includes('FROM payments') &&
        sql(c[0]).includes("status = 'SUCCEEDED'"),
    );
    expect(paymentCalls.length).toBeGreaterThan(0);
    for (const call of paymentCalls) {
      expect(sql(call[0])).not.toContain('exclude_from_analytics');
    }
  });
});
