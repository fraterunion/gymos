import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

const AS_OF = new Date('2026-07-10T14:00:00.000Z');
const STUDIO_A = 'studio-a';
const STUDIO_B = 'studio-b';
const TZ = 'UTC';

const MONTH_START = new Date('2026-07-01T00:00:00.000Z');
const PREV_MONTH_START = new Date('2026-06-01T00:00:00.000Z');
const PREV_MONTH_END = new Date('2026-06-11T00:00:00.000Z');

function sql(strings: TemplateStringsArray): string {
  return strings.join(' ');
}

function hasDate(values: unknown[], target: Date): boolean {
  return values.some(
    (v) => v instanceof Date && v.getTime() === target.getTime(),
  );
}

type PeriodSummary = {
  total_cents: bigint;
  payment_count: bigint;
  stripe_cents: bigint;
  cash_cents: bigint;
  other_cents?: bigint;
};

function setupFinancialMock(
  queryRaw: jest.Mock,
  overrides: {
    current?: PeriodSummary;
    prev?: PeriodSummary;
    pending?: { total_cents: bigint };
    pendingCount?: { c: bigint };
    unattributed?: { cents: bigint };
    methodCounts?: { payment_method: string; payment_count: bigint }[];
    trendRows?: { d: Date | string; amount_cents: bigint; payment_count: bigint }[];
  } = {},
) {
  const current = overrides.current ?? {
    total_cents: 150_000n,
    payment_count: 12n,
    stripe_cents: 120_000n,
    cash_cents: 30_000n,
    other_cents: 0n,
  };
  const prev = overrides.prev ?? {
    total_cents: 100_000n,
    payment_count: 8n,
    stripe_cents: 80_000n,
    cash_cents: 20_000n,
    other_cents: 0n,
  };

  queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = sql(strings);

    if (
      q.includes('payment_count') &&
      q.includes('stripe_cents') &&
      q.includes('other_cents') &&
      hasDate(values, MONTH_START) &&
      hasDate(values, AS_OF)
    ) {
      return Promise.resolve([current]);
    }
    if (
      q.includes('payment_count') &&
      q.includes('stripe_cents') &&
      q.includes('other_cents') &&
      hasDate(values, PREV_MONTH_START) &&
      hasDate(values, PREV_MONTH_END)
    ) {
      return Promise.resolve([prev]);
    }
    if (q.includes("status = 'PENDING'") && q.includes('COUNT')) {
      return Promise.resolve([{ c: overrides.pendingCount?.c ?? 2n }]);
    }
    if (q.includes("status = 'PENDING'")) {
      return Promise.resolve([overrides.pending ?? { total_cents: 5_000n }]);
    }
    if (q.includes('AT TIME ZONE') && q.includes('::date')) {
      return Promise.resolve(overrides.trendRows ?? []);
    }
    if (q.includes('membership_plan_id IS NULL')) {
      return Promise.resolve([overrides.unattributed ?? { cents: 0n }]);
    }
    if (q.includes('GROUP BY payment_method')) {
      return Promise.resolve(
        overrides.methodCounts ?? [
          { payment_method: 'STRIPE', payment_count: 10n },
          { payment_method: 'CASH', payment_count: 2n },
        ],
      );
    }
    if (q.includes('plan_id')) {
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
}

describe('AnalyticsService.getFinancialSummary', () => {
  let service: AnalyticsService;
  let prisma: PrismaService;
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(AS_OF);

    queryRaw = jest.fn();
    setupFinancialMock(queryRaw);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        {
          provide: PrismaService,
          useValue: {
            studio: {
              findUnique: jest.fn().mockResolvedValue({ timezone: TZ }),
            },
            payment: {
              findFirst: jest.fn().mockResolvedValue({ currency: 'mxn' }),
            },
            studioEnrollmentSettings: {
              findUnique: jest.fn().mockResolvedValue({ currency: 'mxn' }),
            },
            membershipPlan: {
              findFirst: jest.fn().mockResolvedValue(null),
            },
            $queryRaw: queryRaw,
          },
        },
      ],
    }).compile();

    service = module.get(AnalyticsService);
    prisma = module.get(PrismaService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('defaults to month period with studio timezone', async () => {
    const result = await service.getFinancialSummary(STUDIO_A, 'month');

    expect(result.period.key).toBe('month');
    expect(result.period.timezone).toBe(TZ);
    expect(result.kpis.totalCollected.cents).toBe(150_000);
    expect(result.kpis.totalCollected.comparisonPercent).toBe(50);
  });

  it('excludes pending from total collected', async () => {
    const result = await service.getFinancialSummary(STUDIO_A, 'month');

    expect(result.kpis.pending.cents).toBe(5_000);
    expect(result.kpis.pending.count).toBe(2);
    expect(result.kpis.totalCollected.cents).toBe(150_000);
  });

  it('classifies stripe vs cash from payment_method', async () => {
    const result = await service.getFinancialSummary(STUDIO_A, 'month');

    expect(result.kpis.stripeCollected.cents).toBe(120_000);
    expect(result.kpis.cashCollected.cents).toBe(30_000);
  });

  it('marks net, fees, taxes, and refunds unavailable', async () => {
    const result = await service.getFinancialSummary(STUDIO_A, 'month');

    expect(result.kpis.netReceived.available).toBe(false);
    expect(result.kpis.stripeFees.available).toBe(false);
    expect(result.kpis.taxes.available).toBe(false);
    expect(result.kpis.refunds.available).toBe(false);
    expect(result.kpis.netReceived.cents).toBeNull();
  });

  it('omits comparison when prior period has zero collected', async () => {
    setupFinancialMock(queryRaw, {
      prev: {
        total_cents: 0n,
        payment_count: 0n,
        stripe_cents: 0n,
        cash_cents: 0n,
      },
    });

    const result = await service.getFinancialSummary(STUDIO_A, 'month');
    expect(result.kpis.totalCollected.comparisonPercent).toBeNull();
  });

  it('scopes queries to studioId', async () => {
    await service.getFinancialSummary(STUDIO_B, 'month');

    for (const call of queryRaw.mock.calls) {
      expect(call.slice(1)).toContain(STUDIO_B);
    }
  });

  it('uses SUCCEEDED status only in period summary', async () => {
    await service.getFinancialSummary(STUDIO_A, 'month');

    const summaryCall = queryRaw.mock.calls.find((c) =>
      sql(c[0]).includes('payment_count'),
    );
    expect(sql(summaryCall![0])).toContain("status = 'SUCCEEDED'");
    expect(sql(summaryCall![0])).toContain('COALESCE(paid_at, created_at)');
  });

  it('prefers enrollment settings currency over payment currency', async () => {
    (prisma.studioEnrollmentSettings.findUnique as jest.Mock).mockResolvedValue({
      currency: 'mxn',
    });
    (prisma.membershipPlan.findFirst as jest.Mock).mockResolvedValue({ currency: 'usd' });
    (prisma.payment.findFirst as jest.Mock).mockResolvedValue({ currency: 'usd' });

    const result = await service.getFinancialSummary(STUDIO_A, 'month');
    expect(result.currency).toBe('mxn');
  });

  it('reconciles total = stripe + cash + other', async () => {
    setupFinancialMock(queryRaw, {
      current: {
        total_cents: 150_000n,
        payment_count: 12n,
        stripe_cents: 100_000n,
        cash_cents: 40_000n,
        other_cents: 10_000n,
      },
      trendRows: [
        { d: '2026-07-01', amount_cents: 100_000n, payment_count: 8n },
        { d: '2026-07-10', amount_cents: 50_000n, payment_count: 4n },
      ],
      methodCounts: [
        { payment_method: 'STRIPE', payment_count: 8n },
        { payment_method: 'CASH', payment_count: 3n },
        { payment_method: 'TERMINAL', payment_count: 1n },
      ],
    });

    const result = await service.getFinancialSummary(STUDIO_A, 'month');
    expect(result.reconciliation?.methodSplitEqualsTotal).toBe(true);
    expect(result.reconciliation?.trendAmountEqualsTotal).toBe(true);
    expect(result.reconciliation?.trendCountEqualsTotal).toBe(true);
    expect(result.reconciliation?.methodCountEqualsTotal).toBe(true);
    expect(result.charts.stripeVsCash).toEqual(
      expect.arrayContaining([
        { method: 'stripe', amountCents: 100_000 },
        { method: 'cash', amountCents: 40_000 },
        { method: 'other', amountCents: 10_000 },
      ]),
    );
  });

  it('includes Sin atribuir when unattributed revenue exists', async () => {
    setupFinancialMock(queryRaw, {
      unattributed: { cents: 25_000n },
    });

    const result = await service.getFinancialSummary(STUDIO_A, 'month');
    expect(result.charts.revenueByPlan).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ planName: 'Sin atribuir', revenueCents: 25_000 }),
      ]),
    );
  });
});
