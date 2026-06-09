import { apiRequest } from '@/lib/api/client';

export type MemberProgressDto = {
  totalCheckIns: number;
  monthCheckIns: number;
  currentStreak: number;
  bestStreak: number;
  favoriteClass: {
    templateId: string;
    name: string;
    category: string | null;
    count: number;
  } | null;
  classBreakdown: Array<{
    templateId: string;
    className: string;
    category: string | null;
    count: number;
  }>;
  recentActivity: Array<{
    date: string;
    className: string;
    category: string | null;
    coachName: string | null;
  }>;
  period: {
    year: number;
    month: number;
    timezone: string;
  };
  generatedAt: string;
};

export type LeaderboardPeriod = 'month' | 'all_time';

export type LeaderboardDto = {
  period: LeaderboardPeriod;
  top: Array<{
    rank: number;
    displayName: string;
    initials: string;
    checkIns: number;
  }>;
  me: {
    rank: number | null;
    checkIns: number;
  };
  generatedAt: string;
};

export async function fetchMyProgress(studioId: string): Promise<MemberProgressDto> {
  return apiRequest<MemberProgressDto>(`/studios/${studioId}/members/me/progress`, {
    method: 'GET',
  });
}

export async function fetchLeaderboard(
  studioId: string,
  period: LeaderboardPeriod = 'month',
): Promise<LeaderboardDto> {
  return apiRequest<LeaderboardDto>(
    `/studios/${studioId}/members/leaderboard?period=${period}`,
    { method: 'GET' },
  );
}
