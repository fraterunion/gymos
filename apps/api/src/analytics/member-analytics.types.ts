import type { MemberAnalyticsPeriodKey } from './member-analytics-range.utils';
import type { MemberEngagementStatusCode } from './member-engagement.utils';

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
  frequencyPopulation: 'active' | 'all';
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
