import { apiRequest } from '@/lib/api/client';

export type AnalyticsOverviewDto = {
  activeMembers: number;
  checkInsToday: number;
  upcomingClassesToday: number;
  occupancyRateToday: number;
  waitlistCount: number;
  noShowRate: number;
  avgClassFill: number;
  bookingsLast7d: number;
  mostPopularTemplate: {
    id: string;
    name: string;
    color: string | null;
    bookingCount: number;
  } | null;
  mostActiveCoach: {
    id: string;
    firstName: string;
    lastName: string;
    classCount: number;
  } | null;
  generatedAt: string;
};

export type BusinessAnalyticsDto = {
  period: { days: number; from: string; to: string };
  dataQuality: 'empty' | 'demo' | 'live' | 'mixed';
  estimatedMrrCents: number;
  activeSubscriptions: number;
  trialingSubscriptions: number;
  pastDueSubscriptions: number;
  pausedSubscriptions: number;
  canceledSubscriptionsTotal: number;
  cancellationsLast30Days: number;
  revenueLast30DaysCents: number;
  cashRevenueLast30DaysCents: number;
  stripeRevenueLast30DaysCents: number;
  averageRevenuePerMemberCents: number;
  memberCountForArpu: number;
  membersWithTwoPlusBookingsLast30Days: number;
  repeatBookingRatePercent: number;
  bookingFrequencyBuckets: { label: string; memberCount: number }[];
  revenueTrend: { date: string; amountCents: number }[];
  subscriptionStatusBreakdown: { status: string; count: number }[];
  revenueByPlan: { planId: string; planName: string; revenueCents: number }[];
  unattributedRevenueCents: number;
  generatedAt: string;
};

export async function fetchAnalyticsOverview(studioId: string): Promise<AnalyticsOverviewDto> {
  return apiRequest<AnalyticsOverviewDto>(`/studios/${studioId}/analytics/overview`, {
    method: 'GET',
  });
}

export async function fetchAnalyticsBusiness(studioId: string): Promise<BusinessAnalyticsDto> {
  return apiRequest<BusinessAnalyticsDto>(`/studios/${studioId}/analytics/business`, {
    method: 'GET',
  });
}

export type FinancialKpiValue = {
  cents?: number | null;
  count?: number;
  comparisonPercent?: number | null;
  available: boolean;
};

export type FinancialSummaryDto = {
  period: {
    key: string;
    timezone: string;
    from: string;
    to: string;
    prevFrom: string;
    prevTo: string;
  };
  currency: string;
  kpis: {
    totalCollected: FinancialKpiValue;
    stripeCollected: FinancialKpiValue;
    cashCollected: FinancialKpiValue;
    otherCollected?: FinancialKpiValue;
    paymentsCollected: FinancialKpiValue;
  };
  charts: {
    collectedTrend: { date: string; amountCents: number; paymentCount: number }[];
    stripeVsCash: { method: string; amountCents: number }[];
  };
  reconciliation?: {
    methodSplitEqualsTotal: boolean;
    trendAmountEqualsTotal: boolean;
  };
  generatedAt: string;
};

export async function fetchAnalyticsFinancial(
  studioId: string,
  period = 'month',
): Promise<FinancialSummaryDto> {
  return apiRequest<FinancialSummaryDto>(
    `/studios/${studioId}/analytics/financial?period=${period}`,
    { method: 'GET' },
  );
}

export type ClassBreakdownDto = {
  periodDays?: number;
  timezone?: string;
  topTemplates: {
    templateId: string;
    name: string;
    color: string | null;
    bookingCount: number;
  }[];
  peakHours: { hour: number; count: number }[];
};

export async function fetchAnalyticsClassBreakdown(
  studioId: string,
  days = 30,
): Promise<ClassBreakdownDto> {
  return apiRequest<ClassBreakdownDto>(
    `/studios/${studioId}/analytics/class-breakdown?days=${days}`,
    { method: 'GET' },
  );
}

export type ExecutiveDashboardDto = {
  currency: string;
  timezone?: string;
  generatedAt: string;
  kpis: {
    id: string;
    label: string;
    value: number;
    valueKind: 'money' | 'count' | 'percent';
    comparisonPercent: number | null;
  }[];
  insights: { id: string; tone: string; title: string; body: string }[];
  activity: {
    id: string;
    type: string;
    memberName: string;
    planName: string | null;
    amountCents: number | null;
    relativeLabel: string;
  }[];
  upcomingRevenue: {
    expected7DaysCents: number;
    expected30DaysCents: number;
    estimationNote: string;
    items: { memberName: string; amountCents: number; renewalDate: string }[];
  };
  failedPayments: {
    paymentId: string;
    memberName: string;
    amountCents: number;
    currency: string;
    failureReason: string | null;
    failureReasonAvailable: boolean;
  }[];
  stripe: {
    pastDueSubscriptions: number;
    activeSubscriptions: number;
  };
  operations: { checkInsToday: number; classesToday: number };
  dataQuality?: { warnings: string[] };
};

export async function fetchAnalyticsExecutive(studioId: string): Promise<ExecutiveDashboardDto> {
  return apiRequest<ExecutiveDashboardDto>(`/studios/${studioId}/analytics/executive`, {
    method: 'GET',
  });
}

/** Revenue for a calendar day key (YYYY-MM-DD) from the 30-day business trend. */
export function revenueCentsForDay(
  trend: BusinessAnalyticsDto['revenueTrend'],
  dayKey: string,
): number {
  return trend.find((row) => row.date === dayKey)?.amountCents ?? 0;
}

/** Sum succeeded payment amounts in trend rows whose date starts with YYYY-MM. */
export function revenueCentsMonthToDate(
  trend: BusinessAnalyticsDto['revenueTrend'],
  yearMonth: string,
): number {
  return trend
    .filter((row) => row.date.startsWith(yearMonth))
    .reduce((sum, row) => sum + row.amountCents, 0);
}
