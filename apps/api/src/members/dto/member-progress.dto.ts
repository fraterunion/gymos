export type MemberProgressClassTemplateDto = {
  id: string;
  name: string;
  color: string | null;
};

export type MemberProgressFavoriteClassDto = MemberProgressClassTemplateDto & {
  checkIns: number;
};

export type MemberProgressClassBreakdownItemDto = {
  classTemplate: MemberProgressClassTemplateDto;
  checkIns: number;
};

export type MemberProgressRecentActivityItemDto = {
  attendanceId: string;
  checkedInAt: string;
  classStartsAt: string;
  classTemplate: MemberProgressClassTemplateDto;
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
