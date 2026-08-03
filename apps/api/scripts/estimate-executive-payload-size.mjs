const slim = {
  currency: 'mxn',
  timezone: 'America/Mexico_City',
  generatedAt: new Date().toISOString(),
  kpis: Array.from({ length: 8 }, (_, i) => ({
    id: `k${i}`,
    label: 'Cobrado este mes',
    value: 123456,
    valueKind: 'money',
    comparisonPercent: 12,
    comparisonLabel: 'vs',
    sparkline: [],
  })),
  revenue: {
    period: 'monthly',
    currency: 'mxn',
    trend: Array.from({ length: 31 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      amountCents: 50000,
      paymentCount: 3,
    })),
    breakdown: {
      subscriptionsCents: 1_000_000,
      oneTimeCents: 200_000,
      retailCents: 0,
      otherCents: 10_000,
      totalCents: 1_210_000,
    },
  },
  activity: Array.from({ length: 30 }, (_, i) => ({
    id: `a${i}`,
    type: 'payment_succeeded',
    memberName: `Member ${i}`,
    memberUserId: `u${i}`,
    planName: 'Unlimited',
    amountCents: 149900,
    paymentMethod: 'Stripe',
    occurredAt: new Date().toISOString(),
    relativeLabel: 'hace 1 h',
  })),
  upcomingRevenue: {
    expected7DaysCents: 500000,
    expected30DaysCents: 2_000_000,
    estimationNote: 'Estimado según catálogo',
    items: Array.from({ length: 20 }, (_, i) => ({
      memberUserId: `u${i}`,
      memberName: `M${i}`,
      planName: 'Plan',
      amountCents: 149900,
      renewalDate: new Date().toISOString(),
      bucket: 'this_week',
      isEstimated: true,
    })),
  },
  insights: Array.from({ length: 6 }, (_, i) => ({
    id: `i${i}`,
    tone: 'neutral',
    title: 'Insight',
    body: 'Texto',
    facts: {},
    priority: i,
  })),
};

const slimBytes = Buffer.byteLength(JSON.stringify(slim), 'utf8');
const legacyBytes = Buffer.byteLength(
  JSON.stringify({
    ...slim,
    legacy: {
      business: {
        revenueTrend: Array.from({ length: 30 }, () => ({ date: '2026-08-01', amountCents: 1 })),
        memberSignupsTrend: Array.from({ length: 30 }, () => ({ date: '2026-08-01', count: 1 })),
      },
      financialMonth: {
        charts: {
          collectedTrend: Array.from({ length: 31 }, () => ({
            date: '2026-08-01',
            amountCents: 1,
            paymentCount: 1,
          })),
        },
      },
      trends: { bookings: [], attendances: [] },
      classBreakdown: { topTemplates: [], peakHours: [] },
    },
  }),
  'utf8',
);

console.log(JSON.stringify({ slimExecutiveBytes: slimBytes, withLegacyBytes: legacyBytes, reductionPercent: Math.round((1 - slimBytes / legacyBytes) * 100) }));
