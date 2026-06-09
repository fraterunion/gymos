export type MemberProgressFavoriteClassDto = {
  templateId: string;
  name: string;
  category: string | null;
  count: number;
};

export type MemberProgressClassBreakdownItemDto = {
  templateId: string;
  className: string;
  category: string | null;
  count: number;
};

export type MemberProgressRecentActivityItemDto = {
  /** scheduledClass.startsAt as ISO string. */
  date: string;
  className: string;
  category: string | null;
  coachName: string | null;
};

export type MemberProgressPeriodDto = {
  year: number;
  month: number;
  timezone: string;
};

export type MemberProgressDto = {
  totalCheckIns: number;
  monthCheckIns: number;
  currentStreak: number;
  bestStreak: number;
  favoriteClass: MemberProgressFavoriteClassDto | null;
  classBreakdown: MemberProgressClassBreakdownItemDto[];
  recentActivity: MemberProgressRecentActivityItemDto[];
  period: MemberProgressPeriodDto;
  generatedAt: string;
};

// ── Leaderboard ───────────────────────────────────────────────────────────────

export type LeaderboardPeriod = 'month' | 'all_time';

export type LeaderboardEntryDto = {
  rank: number;
  displayName: string;
  initials: string;
  checkIns: number;
};

/**
 * Always non-null: even when the caller has 0 check-ins, we return
 * { rank: null, checkIns: 0 } so the client never needs a null guard.
 */
export type LeaderboardMeDto = {
  rank: number | null;
  checkIns: number;
};

export type LeaderboardDto = {
  period: LeaderboardPeriod;
  top: LeaderboardEntryDto[];
  me: LeaderboardMeDto;
  generatedAt: string;
};
