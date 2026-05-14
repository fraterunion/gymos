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
