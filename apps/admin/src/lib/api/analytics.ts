import { apiRequest } from "@/lib/api/client";

// ── Types ───────────────────────────────────────────────────────────────────

export type OverviewDto = {
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

export type TrendsDto = {
  period: { from: string; to: string; days: number };
  bookings: { date: string; count: number }[];
  attendances: { date: string; count: number }[];
};

export type ClassBreakdownDto = {
  topTemplates: {
    templateId: string;
    name: string;
    color: string | null;
    bookingCount: number;
  }[];
  peakHours: { hour: number; count: number }[];
};

export type BusinessAnalyticsDto = {
  period: { days: number; from: string; to: string };
  dataQuality: "empty" | "demo" | "live" | "mixed";
  estimatedMrrCents: number;
  activeSubscriptions: number;
  trialingSubscriptions: number;
  pastDueSubscriptions: number;
  pausedSubscriptions: number;
  canceledSubscriptionsTotal: number;
  cancellationsLast30Days: number;
  revenueLast30DaysCents: number;
  averageRevenuePerMemberCents: number;
  memberCountForArpu: number;
  membersWithTwoPlusBookingsLast30Days: number;
  repeatBookingRatePercent: number;
  bookingFrequencyBuckets: { label: string; memberCount: number }[];
  revenueTrend: { date: string; amountCents: number }[];
  subscriptionStatusBreakdown: { status: string; count: number }[];
  revenueByPlan: { planId: string; planName: string; revenueCents: number }[];
  unattributedRevenueCents: number;
  grossRevenueTodayCents: number;
  grossRevenueYesterdayCents: number;
  revenueTodayVsYesterdayPercent: number | null;
  cashRevenueLast30DaysCents: number;
  stripeRevenueLast30DaysCents: number;
  pendingRevenueCents: number;
  refundedRevenueCents: number;
  dayPassRevenueLast30DaysCents: number;
  newMembersLast30Days: number;
  newMembersPrevious30Days: number;
  membershipGrowthPercent: number | null;
  estimatedArrCents: number;
  averageMembershipPriceCents: number;
  newSubscriptionsToday: number;
  newSubscriptionsLast30Days: number;
  membershipSalesRevenueTodayCents: number;
  enrollmentFeesPaidCount30d: number;
  foundersEnrolledCount: number;
  topSellingPlan: { planId: string; planName: string; revenueCents: number } | null;
  membersInactive30PlusDays: number;
  waiversPendingCount: number;
  expiringMembershipsNext30Days: number;
  averageVisitsPerMember30d: number;
  failedPaymentsLast30Days: number;
  coachUtilizationPercent: number;
  memberSignupsTrend: { date: string; count: number }[];
  generatedAt: string;
};

export type OwnerBriefingDto = {
  hero: {
    monthCollectedCents: number;
    monthPaymentCount: number;
    monthComparisonPercent: number | null;
    delight: string | null;
  };
  attention: {
    id: string;
    label: string;
    action: string;
    href: string;
  }[];
  whatChanged: { id: string; label: string }[];
  payingMembers: {
    count: number;
    newThisWeek: number | null;
    renewalsDueThisWeek: number | null;
  };
  comparisonWindow: "since_yesterday";
  timeBasis: { timezone: string };
  generatedAt: string;
};

// ── Fetchers ────────────────────────────────────────────────────────────────

export async function fetchAnalyticsOverview(studioId: string): Promise<OverviewDto> {
  return apiRequest<OverviewDto>(`/studios/${studioId}/analytics/overview`, { method: "GET" });
}

export async function fetchAnalyticsTrends(studioId: string, days: number): Promise<TrendsDto> {
  return apiRequest<TrendsDto>(
    `/studios/${studioId}/analytics/trends?days=${days}`,
    { method: "GET" },
  );
}

export async function fetchAnalyticsClassBreakdown(
  studioId: string,
  days: number,
): Promise<ClassBreakdownDto> {
  return apiRequest<ClassBreakdownDto>(
    `/studios/${studioId}/analytics/class-breakdown?days=${days}`,
    { method: "GET" },
  );
}

export async function fetchAnalyticsBusiness(studioId: string): Promise<BusinessAnalyticsDto> {
  return apiRequest<BusinessAnalyticsDto>(`/studios/${studioId}/analytics/business`, {
    method: "GET",
  });
}

export async function fetchAnalyticsBriefing(studioId: string): Promise<OwnerBriefingDto> {
  return apiRequest<OwnerBriefingDto>(`/studios/${studioId}/analytics/briefing`, {
    method: "GET",
  });
}
