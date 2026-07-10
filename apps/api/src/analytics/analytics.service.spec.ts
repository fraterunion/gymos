import { Test, TestingModule } from '@nestjs/testing';
import {
  BillingInterval,
  PaymentMethod,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

/** Fixed UTC instant: 2026-07-10 14:00:00 UTC (today starts 2026-07-10T00:00:00Z) */
const AS_OF = new Date('2026-07-10T14:00:00.000Z');

const STUDIO_A = 'studio-a';
const STUDIO_B = 'studio-b';

const TODAY_START = new Date('2026-07-10T00:00:00.000Z');
const TOMORROW_START = new Date('2026-07-11T00:00:00.000Z');
const YESTERDAY_START = new Date('2026-07-09T00:00:00.000Z');

function hasDate(values: unknown[], target: Date): boolean {
  return values.some(
    (v) => v instanceof Date && v.getTime() === target.getTime(),
  );
}

function setupQueryRawMock(
  queryRaw: jest.Mock,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const responses: Record<string, unknown> = {
    day_pass: [{ total_cents: 4000n }],
    pending: [{ total_cents: 12_000n }],
    refunded: [{ total_cents: 2500n }],
    payment_method: [
      { payment_method: PaymentMethod.STRIPE, total_cents: 70_000n },
      { payment_method: PaymentMethod.CASH, total_cents: 30_000n },
    ],
    revenue_today: [{ total_cents: 42_000n }],
    revenue_yesterday: [{ total_cents: 30_000n }],
    revenue_30d: [{ total_cents: 100_000n }],
    revenue_trend: [{ d: new Date('2026-07-09T00:00:00.000Z'), amount_cents: 5000n }],
    repeat_bookers: [{ c: 4n }],
    cancellations_30: [{ c: 2n }],
    booking_mix: [
      { bucket: '1', member_count: 3n },
      { bucket: '2+', member_count: 5n },
    ],
    revenue_by_plan: [
      { plan_id: 'plan-1', plan_name: 'Turbo', revenue_cents: 80_000n },
    ],
    unattributed: [{ cents: 5000n }],
    membership_plan_today: [{ total_cents: 15_000n }],
    inactive: [{ c: 7n }],
    waivers_pending: [{ c: 3n }],
    coach_util: [{ with_coach: 18n, total: 24n }],
    ...overrides,
  };

  queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = sql(strings);

    if (q.includes('day_passes dp')) {
      return Promise.resolve(responses.day_pass);
    }
    if (q.includes("status = 'PENDING'")) {
      return Promise.resolve(responses.pending);
    }
    if (q.includes("status IN ('REFUNDED', 'PARTIALLY_REFUNDED')")) {
      return Promise.resolve(responses.refunded);
    }
    if (q.includes('GROUP BY payment_method')) {
      return Promise.resolve(responses.payment_method);
    }
    if (q.includes('membership_plan_id IS NOT NULL')) {
      return Promise.resolve(responses.membership_plan_today);
    }
    if (q.includes('instructor_id IS NOT NULL')) {
      return Promise.resolve(responses.coach_util);
    }
    if (q.includes('waiver_acceptances wa')) {
      return Promise.resolve(responses.waivers_pending);
    }
    if (q.includes('FROM attendances a')) {
      return Promise.resolve(responses.inactive);
    }
    if (q.includes('sp.membership_plan_id IS NULL')) {
      return Promise.resolve(responses.unattributed);
    }
    if (q.includes('ORDER BY revenue_cents DESC')) {
      return Promise.resolve(responses.revenue_by_plan);
    }
    if (q.includes('v.bucket')) {
      return Promise.resolve(responses.booking_mix);
    }
    if (q.includes("s.status = 'CANCELED'")) {
      return Promise.resolve(responses.cancellations_30);
    }
    if (q.includes('HAVING COUNT(*) >= 2')) {
      return Promise.resolve(responses.repeat_bookers);
    }
    if (q.includes('date_trunc')) {
      return Promise.resolve(responses.revenue_trend);
    }
    if (
      q.includes('COALESCE(SUM(amount_cents), 0)::bigint AS total_cents') &&
      q.includes("status = 'SUCCEEDED'")
    ) {
      if (hasDate(values, TOMORROW_START)) {
        return Promise.resolve(responses.revenue_today);
      }
      if (hasDate(values, YESTERDAY_START) && hasDate(values, TODAY_START)) {
        return Promise.resolve(responses.revenue_yesterday);
      }
      return Promise.resolve(responses.revenue_30d);
    }

    return Promise.resolve([]);
  });
}

function sql(strings: TemplateStringsArray): string {
  return strings.join(' ');
}

function createPrismaMock() {
  const queryRaw = jest.fn();
  setupQueryRawMock(queryRaw);

  const prisma = {
    subscription: {
      groupBy: jest.fn().mockResolvedValue([
        { status: SubscriptionStatus.ACTIVE, _count: { _all: 10 } },
        { status: SubscriptionStatus.TRIALING, _count: { _all: 2 } },
        { status: SubscriptionStatus.PAST_DUE, _count: { _all: 1 } },
      ]),
      findMany: jest.fn().mockResolvedValue([
        {
          membershipPlan: {
            priceCents: 10_000,
            billingInterval: BillingInterval.MONTHLY,
          },
        },
        {
          membershipPlan: {
            priceCents: 120_000,
            billingInterval: BillingInterval.YEARLY,
          },
        },
      ]),
      count: jest
        .fn()
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(4),
    },
    studioMembership: {
      count: jest
        .fn()
        .mockResolvedValueOnce(20)
        .mockResolvedValueOnce(6)
        .mockResolvedValueOnce(4),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([
        { stripePaymentIntentId: 'pi_live_abc', stripeInvoiceId: 'in_live_xyz' },
      ]),
      count: jest.fn().mockResolvedValue(2),
    },
    memberEnrollment: {
      count: jest.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(8),
    },
    attendance: {
      count: jest.fn().mockResolvedValue(40),
    },
    $queryRaw: queryRaw,
  };

  return { prisma, queryRaw };
}

describe('AnalyticsService.getBusinessAnalytics', () => {
  let service: AnalyticsService;
  let prisma: ReturnType<typeof createPrismaMock>['prisma'];
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(AS_OF);

    const mocks = createPrismaMock();
    prisma = mocks.prisma;
    queryRaw = mocks.queryRaw;

    const module: TestingModule = await Test.createTestingModule({
      providers: [AnalyticsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(AnalyticsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('computes gross revenue today from succeeded payments in UTC today window', async () => {
    setupQueryRawMock(queryRaw, {
      revenue_today: [{ total_cents: 42_000n }],
      revenue_yesterday: [{ total_cents: 30_000n }],
    });

    const result = await service.getBusinessAnalytics(STUDIO_A);

    expect(result.grossRevenueTodayCents).toBe(42_000);
    expect(result.grossRevenueYesterdayCents).toBe(30_000);
    expect(result.revenueTodayVsYesterdayPercent).toBe(40);
  });

  it('excludes pending payments from confirmed gross revenue totals', async () => {
    setupQueryRawMock(queryRaw, {
      revenue_30d: [{ total_cents: 100_000n }],
      pending: [{ total_cents: 12_000n }],
    });

    const result = await service.getBusinessAnalytics(STUDIO_A);

    expect(result.revenueLast30DaysCents).toBe(100_000);
    expect(result.pendingRevenueCents).toBe(12_000);
    expect(result.revenueLast30DaysCents).not.toBe(result.pendingRevenueCents);
  });

  it('splits stripe and cash revenue from payment_method aggregation', async () => {
    setupQueryRawMock(queryRaw, {
      payment_method: [
        { payment_method: PaymentMethod.STRIPE, total_cents: 70_000n },
        { payment_method: PaymentMethod.CASH, total_cents: 30_000n },
        { payment_method: PaymentMethod.TERMINAL, total_cents: 5000n },
      ],
    });

    const result = await service.getBusinessAnalytics(STUDIO_A);

    expect(result.stripeRevenueLast30DaysCents).toBe(75_000);
    expect(result.cashRevenueLast30DaysCents).toBe(30_000);
  });

  it('reports refunded payments separately from gross revenue', async () => {
    setupQueryRawMock(queryRaw, {
      refunded: [{ total_cents: 2500n }],
      revenue_30d: [{ total_cents: 100_000n }],
    });

    const result = await service.getBusinessAnalytics(STUDIO_A);

    expect(result.refundedRevenueCents).toBe(2500);
    expect(result.revenueLast30DaysCents).toBe(100_000);
  });

  it('counts new members in current and prior 30-day windows', async () => {
    const result = await service.getBusinessAnalytics(STUDIO_A);

    expect(result.newMembersLast30Days).toBe(6);
    expect(result.newMembersPrevious30Days).toBe(4);
    expect(result.membershipGrowthPercent).toBe(50);
  });

  it('returns null membership growth percent when prior period is zero and current is positive', async () => {
    prisma.studioMembership.count = jest
      .fn()
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(0);

    const result = await service.getBusinessAnalytics(STUDIO_A);

    expect(result.newMembersLast30Days).toBe(5);
    expect(result.newMembersPrevious30Days).toBe(0);
    expect(result.membershipGrowthPercent).toBeNull();
  });

  it('counts subscriptions created today and in the last 30 days', async () => {
    const result = await service.getBusinessAnalytics(STUDIO_A);

    expect(result.newSubscriptionsToday).toBe(3);
    expect(result.newSubscriptionsLast30Days).toBe(2);
  });

  it('aggregates day-pass revenue via day_passes payment_intent join', async () => {
    setupQueryRawMock(queryRaw, {
      day_pass: [{ total_cents: 4000n }],
    });

    const result = await service.getBusinessAnalytics(STUDIO_A);

    expect(result.dayPassRevenueLast30DaysCents).toBe(4000);
  });

  it('counts inactive members, pending waivers, and expiring memberships', async () => {
    setupQueryRawMock(queryRaw, {
      inactive: [{ c: 7n }],
      waivers_pending: [{ c: 3n }],
    });

    const result = await service.getBusinessAnalytics(STUDIO_A);

    expect(result.membersInactive30PlusDays).toBe(7);
    expect(result.waiversPendingCount).toBe(3);
    expect(result.expiringMembershipsNext30Days).toBe(4);
  });

  it('scopes all prisma reads to the requested studioId', async () => {
    await service.getBusinessAnalytics(STUDIO_A);

    expect(prisma.subscription.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studioId: STUDIO_A } }),
    );
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ studioId: STUDIO_A }) }),
    );
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ studioId: STUDIO_A }) }),
    );

    for (const call of queryRaw.mock.calls) {
      const values = call.slice(1);
      expect(values).toContain(STUDIO_A);
    }
  });

  it('isolates tenants — studio B does not receive studio A studioId in queries', async () => {
    await service.getBusinessAnalytics(STUDIO_B);

    expect(prisma.subscription.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studioId: STUDIO_B } }),
    );
    for (const call of queryRaw.mock.calls) {
      const values = call.slice(1);
      expect(values).not.toContain(STUDIO_A);
      expect(values).toContain(STUDIO_B);
    }
  });

  it('excludes deleted memberships and users from registered member count', async () => {
    await service.getBusinessAnalytics(STUDIO_A);

    const memberCountCall = prisma.studioMembership.count.mock.calls[0]?.[0];
    expect(memberCountCall).toEqual({
      where: {
        studioId: STUDIO_A,
        deletedAt: null,
        role: Role.MEMBER,
        user: { deletedAt: null },
      },
    });
  });

  it('documents memberCountForArpu as registered MEMBER seats not active subscriptions', async () => {
    const result = await service.getBusinessAnalytics(STUDIO_A);

    expect(result.memberCountForArpu).toBe(20);
    expect(result.activeSubscriptions).toBe(10);
    expect(result.memberCountForArpu).not.toBe(result.activeSubscriptions);
  });
});
