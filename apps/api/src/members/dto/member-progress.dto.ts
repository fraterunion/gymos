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
