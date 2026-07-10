import { Test, TestingModule } from '@nestjs/testing';
import { PaymentStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

const AS_OF = new Date('2026-07-10T14:00:00.000Z');
const STUDIO_A = 'studio-a';
const STUDIO_B = 'studio-b';
const TZ = 'UTC';

const MONTH_START = new Date('2026-07-01T00:00:00.000Z');
const PREV_MONTH_START = new Date('2026-06-01T00:00:00.000Z');
const PREV_PERIOD_END = new Date('2026-06-11T00:00:00.000Z');
const YESTERDAY_START = new Date('2026-07-09T00:00:00.000Z');
const TODAY_START = new Date('2026-07-10T00:00:00.000Z');
const TOMORROW_START = new Date('2026-07-11T00:00:00.000Z');
const WEEK_AHEAD = new Date(AS_OF.getTime() + 7 * 24 * 60 * 60 * 1000);

function sql(strings: TemplateStringsArray): string {
  return strings.join(' ');
}

function hasDate(values: unknown[], target: Date): boolean {
  return values.some(
    (v) => v instanceof Date && v.getTime() === target.getTime(),
  );
}

type QueryResponses = {
  mtd?: { total_cents: bigint; payment_count: bigint };
  prevMtd?: { total_cents: bigint };
  revenueToday?: { total_cents: bigint };
  revenueYesterday?: { total_cents: bigint };
  pastDue?: { c: bigint };
  expiring?: { c: bigint };
  waivers?: { c: bigint };
  paymentsSinceYesterday?: { c: bigint };
  payingMembers?: { c: bigint };
  newPayingWeek?: { c: bigint };
};

function setupQueryRawMock(queryRaw: jest.Mock, overrides: QueryResponses = {}) {
  const responses: Required<QueryResponses> = {
    mtd: { total_cents: 182_450n, payment_count: 32n },
    prevMtd: { total_cents: 167_000n },
    revenueToday: { total_cents: 15_000n },
    revenueYesterday: { total_cents: 12_000n },
    pastDue: { c: 2n },
    expiring: { c: 4n },
    waivers: { c: 2n },
    paymentsSinceYesterday: { c: 5n },
    payingMembers: { c: 214n },
    newPayingWeek: { c: 4n },
    ...overrides,
  };

  queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = sql(strings);

    if (q.includes('payment_count')) {
      return Promise.resolve([responses.mtd]);
    }
    if (
      q.includes('COALESCE(paid_at, created_at)') &&
      hasDate(values, PREV_MONTH_START) &&
      hasDate(values, PREV_PERIOD_END)
    ) {
      return Promise.resolve([responses.prevMtd]);
    }
    if (
      q.includes('COALESCE(paid_at, created_at)') &&
      hasDate(values, TODAY_START) &&
      hasDate(values, TOMORROW_START)
    ) {
      return Promise.resolve([responses.revenueToday]);
    }
    if (
      q.includes('COALESCE(paid_at, created_at)') &&
      hasDate(values, YESTERDAY_START) &&
      hasDate(values, TODAY_START) &&
      q.includes('total_cents')
    ) {
      return Promise.resolve([responses.revenueYesterday]);
    }
    if (q.includes("status = 'PAST_DUE'")) {
      return Promise.resolve([responses.pastDue]);
    }
    if (q.includes('current_period_end')) {
      return Promise.resolve([responses.expiring]);
    }
    if (q.includes('waiver_acceptances wa')) {
      return Promise.resolve([responses.waivers]);
    }
    if (
      q.includes('COALESCE(paid_at, created_at)') &&
      hasDate(values, YESTERDAY_START) &&
      q.includes('COUNT(*)')
    ) {
      return Promise.resolve([responses.paymentsSinceYesterday]);
    }
    if (
      q.includes('COUNT(DISTINCT user_id)') &&
      q.includes("status IN ('ACTIVE', 'TRIALING')") &&
      q.includes('created_at >=')
    ) {
      return Promise.resolve([responses.newPayingWeek]);
    }
    if (
      q.includes('COUNT(DISTINCT user_id)') &&
      q.includes("status IN ('ACTIVE', 'TRIALING')") &&
      !q.includes('created_at')
    ) {
      return Promise.resolve([responses.payingMembers]);
    }

    return Promise.resolve([]);
  });
}

function createBriefingPrismaMock(overrides: QueryResponses = {}) {
  const queryRaw = jest.fn();
  setupQueryRawMock(queryRaw, overrides);

  return {
    prisma: {
      studio: {
        findUnique: jest.fn().mockResolvedValue({ timezone: TZ }),
      },
      payment: {
        count: jest.fn().mockResolvedValue(1),
      },
      studioMembership: {
        count: jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(6),
      },
      attendance: {
        count: jest.fn().mockResolvedValue(18),
      },
      $queryRaw: queryRaw,
    },
    queryRaw,
  };
}

describe('AnalyticsService.getOwnerBriefing', () => {
  let service: AnalyticsService;
  let prisma: ReturnType<typeof createBriefingPrismaMock>['prisma'];
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(AS_OF);

    const mocks = createBriefingPrismaMock();
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

  it('returns MTD collected revenue using COALESCE(paid_at, created_at)', async () => {
    const result = await service.getOwnerBriefing(STUDIO_A);

    expect(result.hero.monthCollectedCents).toBe(182_450);
    expect(result.hero.monthPaymentCount).toBe(32);

    const mtdCall = queryRaw.mock.calls.find((call) =>
      sql(call[0]).includes('payment_count'),
    );
    expect(mtdCall).toBeDefined();
    expect(sql(mtdCall![0])).toContain('COALESCE(paid_at, created_at)');
    expect(mtdCall!.slice(1)).toContain(STUDIO_A);
    expect(mtdCall!.slice(1)).toContainEqual(MONTH_START);
  });

  it('compares MTD to same point last month using studio-local aligned day', async () => {
    const result = await service.getOwnerBriefing(STUDIO_A);

    const prevCall = queryRaw.mock.calls.find(
      (call) =>
        sql(call[0]).includes('COALESCE(paid_at, created_at)') &&
        sql(call[0]).includes('total_cents') &&
        !sql(call[0]).includes('payment_count') &&
        hasDate(call.slice(1), PREV_MONTH_START),
    );
    expect(prevCall).toBeDefined();
    expect(prevCall!.slice(1)).toContainEqual(PREV_PERIOD_END);
    expect(result.hero.monthComparisonPercent).toBeCloseTo(9.3, 1);
  });

  it('omits month comparison when prior period revenue is zero', async () => {
    setupQueryRawMock(queryRaw, { prevMtd: { total_cents: 0n } });

    const result = await service.getOwnerBriefing(STUDIO_A);

    expect(result.hero.monthComparisonPercent).toBeNull();
  });

  it('counts paying members as distinct users with ACTIVE or TRIALING subscriptions', async () => {
    const result = await service.getOwnerBriefing(STUDIO_A);

    expect(result.payingMembers.count).toBe(214);

    const payingCall = queryRaw.mock.calls.find(
      (call) =>
        sql(call[0]).includes('COUNT(DISTINCT user_id)') &&
        sql(call[0]).includes("status IN ('ACTIVE', 'TRIALING')") &&
        !sql(call[0]).includes('created_at'),
    );
    expect(payingCall!.slice(1)).toContain(STUDIO_A);
  });

  it('deduplicates newThisWeek by distinct user_id', async () => {
    setupQueryRawMock(queryRaw, { newPayingWeek: { c: 1n }, payingMembers: { c: 2n } });

    const result = await service.getOwnerBriefing(STUDIO_A);

    expect(result.payingMembers.newThisWeek).toBe(1);

    const newWeekCall = queryRaw.mock.calls.find((call) =>
      sql(call[0]).includes('created_at >='),
    );
    expect(sql(newWeekCall![0])).toContain('COUNT(DISTINCT user_id)');
  });

  it('deduplicates renewalsDueThisWeek by distinct user_id', async () => {
    setupQueryRawMock(queryRaw, { expiring: { c: 1n } });

    const result = await service.getOwnerBriefing(STUDIO_A);

    expect(result.payingMembers.renewalsDueThisWeek).toBe(1);

    const expiringCall = queryRaw.mock.calls.find((call) =>
      sql(call[0]).includes('current_period_end'),
    );
    expect(sql(expiringCall![0])).toContain('COUNT(DISTINCT user_id)');
    expect(expiringCall!.slice(1)).toContainEqual(WEEK_AHEAD);
  });

  it('routes revenue-behind attention to analytics charts anchor', async () => {
    queryRaw.mockReset();
    setupQueryRawMock(queryRaw, {
      mtd: { total_cents: 80_000n, payment_count: 10n },
      prevMtd: { total_cents: 100_000n },
      pastDue: { c: 0n },
      expiring: { c: 0n },
      waivers: { c: 0n },
      payingMembers: { c: 10n },
      newPayingWeek: { c: 0n },
      paymentsSinceYesterday: { c: 0n },
      revenueToday: { total_cents: 0n },
      revenueYesterday: { total_cents: 0n },
    });
    prisma.payment.count = jest.fn().mockResolvedValue(0);
    prisma.studioMembership.count = jest.fn().mockResolvedValue(0);
    prisma.attendance.count = jest.fn().mockResolvedValue(0);

    const result = await service.getOwnerBriefing(STUDIO_A);

    const revenueBehind = result.attention.find((a) => a.id === 'revenue-behind');
    expect(revenueBehind?.href).toBe('/analytics#analytics-charts');
  });

  it('builds attention items in priority order up to five rows', async () => {
    const result = await service.getOwnerBriefing(STUDIO_A);

    expect(result.attention.map((a) => a.id)).toEqual([
      'overdue',
      'failed',
      'expiring',
      'waivers',
    ]);
    expect(result.attention[0]?.href).toBe('/memberships');
    expect(result.attention[3]?.href).toBe('/members');
  });

  it('returns empty attention when counts are zero', async () => {
    setupQueryRawMock(queryRaw, {
      pastDue: { c: 0n },
      expiring: { c: 0n },
      waivers: { c: 0n },
      mtd: { total_cents: 100_000n, payment_count: 10n },
      prevMtd: { total_cents: 100_000n },
    });
    prisma.payment.count = jest.fn().mockResolvedValue(0);
    prisma.studioMembership.count = jest.fn().mockResolvedValue(0);
    prisma.attendance.count = jest.fn().mockResolvedValue(0);

    const result = await service.getOwnerBriefing(STUDIO_A);

    expect(result.attention).toEqual([]);
    expect(result.hero.delight).toBe('Everything looks healthy.');
  });

  it('populates what changed since yesterday without zero-padding', async () => {
    const result = await service.getOwnerBriefing(STUDIO_A);

    expect(result.whatChanged.length).toBeGreaterThan(0);
    expect(result.whatChanged.some((r) => r.id === 'new-memberships')).toBe(true);
    expect(result.comparisonWindow).toBe('since_yesterday');
    expect(result.timeBasis.timezone).toBe(TZ);
  });

  it('scopes new memberships to MEMBER studio memberships', async () => {
    await service.getOwnerBriefing(STUDIO_A);

    expect(prisma.studioMembership.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          studioId: STUDIO_A,
          role: Role.MEMBER,
          deletedAt: null,
          createdAt: { gte: YESTERDAY_START },
        }),
      }),
    );
  });

  it('isolates tenants by studioId', async () => {
    await service.getOwnerBriefing(STUDIO_B);

    for (const call of queryRaw.mock.calls) {
      expect(call.slice(1)).toContain(STUDIO_B);
      expect(call.slice(1)).not.toContain(STUDIO_A);
    }
  });

  it('excludes non-succeeded payments from MTD collected revenue', async () => {
    await service.getOwnerBriefing(STUDIO_A);

    const mtdCall = queryRaw.mock.calls.find((call) =>
      sql(call[0]).includes('payment_count'),
    );
    expect(sql(mtdCall![0])).toContain("status = 'SUCCEEDED'");
  });

  it('uses February 28 as aligned end when comparing March 31', async () => {
    jest.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));

    await service.getOwnerBriefing(STUDIO_A);

    const prevCall = queryRaw.mock.calls.find(
      (call) =>
        sql(call[0]).includes('COALESCE(paid_at, created_at)') &&
        sql(call[0]).includes('total_cents') &&
        !sql(call[0]).includes('payment_count'),
    );
    expect(prevCall!.slice(1)).toContainEqual(new Date('2026-02-01T00:00:00.000Z'));
    expect(prevCall!.slice(1)).toContainEqual(new Date('2026-03-01T00:00:00.000Z'));
  });
});

describe('AnalyticsService.getOwnerBriefing — distinct paying members', () => {
  let service: AnalyticsService;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(AS_OF);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts one user with two ACTIVE subscriptions once', async () => {
    const queryRaw = jest.fn().mockImplementation((strings: TemplateStringsArray) => {
      const q = sql(strings);
      if (q.includes('payment_count')) {
        return Promise.resolve([{ total_cents: 0n, payment_count: 0n }]);
      }
      if (q.includes("status = 'PAST_DUE'")) {
        return Promise.resolve([{ c: 0n }]);
      }
      if (q.includes('current_period_end')) {
        return Promise.resolve([{ c: 0n }]);
      }
      if (q.includes('waiver_acceptances')) {
        return Promise.resolve([{ c: 0n }]);
      }
      if (q.includes('COUNT(DISTINCT user_id)') && q.includes('created_at')) {
        return Promise.resolve([{ c: 0n }]);
      }
      if (q.includes('COUNT(DISTINCT user_id)')) {
        return Promise.resolve([{ c: 1n }]);
      }
      if (q.includes('total_cents')) {
        return Promise.resolve([{ total_cents: 0n }]);
      }
      if (q.includes('COUNT(*)') && q.includes('COALESCE(paid_at')) {
        return Promise.resolve([{ c: 0n }]);
      }
      return Promise.resolve([]);
    });

    const prisma = {
      studio: { findUnique: jest.fn().mockResolvedValue({ timezone: TZ }) },
      payment: { count: jest.fn().mockResolvedValue(0) },
      studioMembership: { count: jest.fn().mockResolvedValue(0) },
      attendance: { count: jest.fn().mockResolvedValue(0) },
      $queryRaw: queryRaw,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AnalyticsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(AnalyticsService);
    const result = await service.getOwnerBriefing(STUDIO_A);

    expect(result.payingMembers.count).toBe(1);
  });

  it('counts two distinct users twice', async () => {
    const queryRaw = jest.fn().mockImplementation((strings: TemplateStringsArray) => {
      const q = sql(strings);
      if (q.includes('COUNT(DISTINCT user_id)') && !q.includes('created_at')) {
        return Promise.resolve([{ c: 2n }]);
      }
      if (q.includes('payment_count')) {
        return Promise.resolve([{ total_cents: 0n, payment_count: 0n }]);
      }
      if (q.includes('total_cents')) {
        return Promise.resolve([{ total_cents: 0n }]);
      }
      return Promise.resolve([{ c: 0n }]);
    });

    const prisma = {
      studio: { findUnique: jest.fn().mockResolvedValue({ timezone: TZ }) },
      payment: { count: jest.fn().mockResolvedValue(0) },
      studioMembership: { count: jest.fn().mockResolvedValue(0) },
      attendance: { count: jest.fn().mockResolvedValue(0) },
      $queryRaw: queryRaw,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AnalyticsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(AnalyticsService);
    const result = await service.getOwnerBriefing(STUDIO_A);

    expect(result.payingMembers.count).toBe(2);
  });

  it('excludes subscriptions from another studio', async () => {
    const queryRaw = jest.fn();
    setupQueryRawMock(queryRaw, { payingMembers: { c: 3n } });

    const prisma = {
      studio: { findUnique: jest.fn().mockResolvedValue({ timezone: TZ }) },
      payment: { count: jest.fn().mockResolvedValue(0) },
      studioMembership: { count: jest.fn().mockResolvedValue(0) },
      attendance: { count: jest.fn().mockResolvedValue(0) },
      $queryRaw: queryRaw,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AnalyticsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(AnalyticsService);
    await service.getOwnerBriefing(STUDIO_B);

    const payingCall = queryRaw.mock.calls.find(
      (call) =>
        sql(call[0]).includes('COUNT(DISTINCT user_id)') &&
        !sql(call[0]).includes('created_at'),
    );
    expect(payingCall!.slice(1)).toContain(STUDIO_B);
    expect(payingCall!.slice(1)).not.toContain(STUDIO_A);
  });

  it('does not count PAST_DUE or CANCELED toward paying members', async () => {
    const queryRaw = jest.fn();
    setupQueryRawMock(queryRaw);

    const prisma = {
      studio: { findUnique: jest.fn().mockResolvedValue({ timezone: TZ }) },
      payment: { count: jest.fn().mockResolvedValue(0) },
      studioMembership: { count: jest.fn().mockResolvedValue(0) },
      attendance: { count: jest.fn().mockResolvedValue(0) },
      $queryRaw: queryRaw,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AnalyticsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(AnalyticsService);
    await service.getOwnerBriefing(STUDIO_A);

    const payingCall = queryRaw.mock.calls.find(
      (call) =>
        sql(call[0]).includes('COUNT(DISTINCT user_id)') &&
        sql(call[0]).includes("status IN ('ACTIVE', 'TRIALING')"),
    );
    expect(sql(payingCall![0])).not.toContain('PAST_DUE');
    expect(sql(payingCall![0])).not.toContain('CANCELED');
  });
});

describe('AnalyticsService.getOwnerBriefing — collected-at timestamp', () => {
  let queryRaw: jest.Mock;
  let service: AnalyticsService;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(AS_OF);

    queryRaw = jest.fn();
    setupQueryRawMock(queryRaw);

    const prisma = {
      studio: { findUnique: jest.fn().mockResolvedValue({ timezone: TZ }) },
      payment: { count: jest.fn().mockResolvedValue(0) },
      studioMembership: { count: jest.fn().mockResolvedValue(0) },
      attendance: { count: jest.fn().mockResolvedValue(0) },
      $queryRaw: queryRaw,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AnalyticsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(AnalyticsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('filters all briefing revenue queries on COALESCE(paid_at, created_at)', async () => {
    await service.getOwnerBriefing(STUDIO_A);

    const revenueCalls = queryRaw.mock.calls.filter((call) =>
      sql(call[0]).includes('COALESCE(paid_at, created_at)'),
    );

    expect(revenueCalls.length).toBeGreaterThanOrEqual(4);
    for (const call of revenueCalls) {
      expect(sql(call[0])).toContain("status = 'SUCCEEDED'");
    }
  });
});
