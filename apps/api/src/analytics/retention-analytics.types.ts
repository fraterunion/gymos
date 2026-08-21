import type {
  RetentionHealth,
  RetentionMovement,
  RetentionSuggestedAction,
} from './retention-engagement.utils';

export type RetentionSummaryDto = {
  timezone: string;
  analyticsDataAvailableFrom: string | null;
  current30Start: string;
  current30End: string;
  previous30Start: string;
  previous30End: string;
  kpis: {
    activeMembers: number;
    atRisk: number;
    inactive: number;
    recovered: number;
    observation: number;
    /** Visits last 30d among entitled */
    frequencyVisitsNumerator: number;
    /** Entitled members with ≥1 visit in last 30d */
    frequencyAttendingDenominator: number;
    /** Currently entitled members */
    frequencyEntitledDenominator: number;
    /** Visits last 30d / entitled members with ≥1 visit in last 30d */
    frequencyVisitsPerAttending: number | null;
    /** Visits last 30d / currently entitled members */
    frequencyVisitsPerEntitled: number | null;
  };
  populations: {
    allMembers: number;
    entitled: number;
    lapsed: number;
    attending30d: number;
  };
};

export type RetentionMemberRowDto = {
  userId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  planName: string | null;
  isEntitled: boolean;
  joinedAt: string;
  health: RetentionHealth;
  movement: RetentionMovement;
  lastVisitAt: string | null;
  daysSinceLastVisit: number | null;
  visits30d: number;
  visitsPrior30d: number;
  visits90d: number;
  deltaPct: number | null;
  streak: number;
  reason: string;
  suggestedAction: RetentionSuggestedAction;
  isRecovered: boolean;
  recoveredReasons: string[];
  favoriteClass: string | null;
  favoriteTime: string | null;
  favoriteWeekday: number | null;
  favoriteInstructor: string | null;
  patternSentence: string;
  visitsPerWeek: number;
};

export type RetentionMembersDto = {
  data: RetentionMemberRowDto[];
  total: number;
  page: number;
  limit: number;
};

export type RetentionCohortCellDto = {
  monthOffset: number;
  retained: number;
  cohortSize: number;
  ratePct: number | null;
  /** Immature / not yet elapsed / pre-data history */
  suppressed: boolean;
  suppressReason: string | null;
  /**
   * Target month overlaps analyticsDataAvailableFrom mid-month
   * (early lifecycle days unobserved). Not suppressed — annotated.
   */
  limitedHistoryCoverage: boolean;
  limitedHistoryReason: string | null;
};

export type RetentionCohortDto = {
  cohortMonth: string;
  cohortSize: number;
  suppressed: boolean;
  suppressReason: string | null;
  cells: RetentionCohortCellDto[];
};

export type RetentionClassStickinessDto = {
  classTemplateId: string;
  className: string;
  uniqueMembers: number;
  attendances: number;
  avgVisitsPerMember: number;
  seedMembers: number;
  return7dRatePct: number | null;
  return14dRatePct: number | null;
  return30dRatePct: number | null;
  sampleInsufficient: boolean;
};

export type RetentionMovementBucketDto = {
  movement: RetentionMovement;
  count: number;
};

export type RetentionFrequencyTrendDto = {
  month: string;
  attendances: number;
  uniqueAttending: number;
  visitsPerAttending: number | null;
  isPartial: boolean;
  isCurrentMonth: boolean;
};

export type RetentionActivityDto = {
  timezone: string;
  analyticsDataAvailableFrom: string | null;
  requiresAction: RetentionMemberRowDto[];
  movement: RetentionMovementBucketDto[];
  cohorts: RetentionCohortDto[];
  classStickiness: RetentionClassStickinessDto[];
  frequencyTrend: RetentionFrequencyTrendDto[];
  limitedHistoryMessage: string | null;
};

export type RetentionMemberDetailDto = RetentionMemberRowDto & {
  monthlyTrend: Array<{ month: string; attendances: number; isPartial: boolean }>;
};
