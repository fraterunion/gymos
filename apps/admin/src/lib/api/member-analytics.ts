import { apiRequest } from "@/lib/api/client";

export type MemberAnalyticsPeriodKey =
  | "this_month"
  | "prev_month"
  | "last_30d"
  | "last_90d"
  | "this_year"
  | "custom";

export type MemberEngagementStatusCode =
  | "VERY_ACTIVE"
  | "ACTIVE"
  | "LOW_ACTIVITY"
  | "AT_RISK"
  | "INACTIVE";

export type MemberAnalyticsSummaryDto = {
  period: MemberAnalyticsPeriodKey;
  periodLabel: string;
  timezone: string;
  periodStart: string;
  periodEnd: string;
  isPartialPeriod: boolean;
  kpis: {
    activeMembers: number;
    membersAttended: number;
    attendances: number;
    visitsPerAttendingMember: number | null;
    visitsPerActiveMember: number | null;
    weeklyFrequencyPerAttendingMember: number | null;
    inactive14PlusDays: number;
    newMembers: number;
    engagementTrendPct: number | null;
  };
};

export type MemberAnalyticsRowDto = {
  userId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  planName: string | null;
  visitsPeriod: number;
  visits30d: number;
  visits90d: number;
  visitsPerWeek: number;
  lastVisitAt: string | null;
  favoriteClass: string | null;
  favoriteTime: string | null;
  consecutiveWeekStreak: number;
  activeWeeks90d: number;
  trendPct: number | null;
  engagementStatus: MemberEngagementStatusCode;
  engagementReasons: string[];
};

export type MemberAnalyticsListDto = {
  data: MemberAnalyticsRowDto[];
  total: number;
  page: number;
  limit: number;
};

export type MemberAnalyticsDetailDto = MemberAnalyticsRowDto & {
  joinedAt: string;
  isEntitled: boolean;
  visitsPrior30d: number;
  firstVisitAt: string | null;
  favoriteInstructor: string | null;
  favoriteWeekday: number | null;
  bookingsPeriod: number;
  attendedBookingsPeriod: number;
  walkInsPeriod: number;
  attendanceRatePct: number | null;
  noShowsPeriod: number;
  monthlyTrend: Array<{ month: string; attendances: number; isPartial: boolean }>;
};

export type MemberAnalyticsActivityDto = {
  topActive: MemberAnalyticsRowDto[];
  requiresAttention: Array<MemberAnalyticsRowDto & { attentionReasons: string[] }>;
  frequencyDistribution: Array<{ bucket: string; memberCount: number }>;
  frequencyPopulation: "active" | "all";
  classPreferences: Array<{
    classTemplateId: string;
    className: string;
    uniqueMembers: number;
    attendances: number;
    visitsPerMember: number;
    attendanceSharePct: number;
  }>;
  dayTimeHeatmap: Array<{
    weekday: number;
    timeBucket: string;
    attendances: number;
    uniqueMembers: number;
  }>;
  monthlyTrend: Array<{
    month: string;
    attendances: number;
    uniqueMembers: number;
    visitsPerMember: number | null;
    isPartial: boolean;
  }>;
  planUtilization: Array<{
    planId: string;
    planName: string;
    memberCount: number;
    avgVisitsPerMember: number;
  }> | null;
};

function qs(params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export async function fetchMemberAnalyticsSummary(
  studioId: string,
  period: MemberAnalyticsPeriodKey = "this_month",
) {
  return apiRequest<MemberAnalyticsSummaryDto>(
    `/studios/${studioId}/analytics/members/summary${qs({ period })}`,
  );
}

export async function fetchMemberAnalyticsList(
  studioId: string,
  params: {
    period?: MemberAnalyticsPeriodKey;
    search?: string;
    sort?: string;
    order?: "asc" | "desc";
    page?: number;
    limit?: number;
    status?: string;
  } = {},
) {
  return apiRequest<MemberAnalyticsListDto>(
    `/studios/${studioId}/analytics/members${qs(params)}`,
  );
}

export async function fetchMemberAnalyticsDetail(
  studioId: string,
  userId: string,
  period: MemberAnalyticsPeriodKey = "this_month",
) {
  return apiRequest<MemberAnalyticsDetailDto>(
    `/studios/${studioId}/analytics/members/${userId}${qs({ period })}`,
  );
}

export async function fetchMemberAnalyticsActivity(
  studioId: string,
  period: MemberAnalyticsPeriodKey = "this_month",
  frequencyPopulation: "active" | "all" = "active",
) {
  return apiRequest<MemberAnalyticsActivityDto>(
    `/studios/${studioId}/analytics/members/activity${qs({ period, frequencyPopulation })}`,
  );
}
