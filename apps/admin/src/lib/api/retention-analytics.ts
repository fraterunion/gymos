import { apiRequest } from "@/lib/api/client";

export type RetentionHealth =
  | "HEALTHY"
  | "OBSERVATION"
  | "AT_RISK"
  | "INACTIVE"
  | "LAPSED";

export type RetentionMovement =
  | "MEJORANDO"
  | "ESTABLE"
  | "BAJANDO"
  | "EN_RIESGO"
  | "RECUPERADO"
  | "SIN_ACTIVIDAD"
  | "MEMBRESIA_FINALIZADA"
  | "SIN_BASELINE";

export type RetentionSuggestedAction =
  | "CONTACTAR"
  | "DAR_SEGUIMIENTO"
  | "REVISAR_MEMBRESIA"
  | "FELICITAR_REGRESO"
  | "SIN_ACCION";

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
    frequencyVisitsNumerator: number;
    frequencyAttendingDenominator: number;
    frequencyEntitledDenominator: number;
    frequencyVisitsPerAttending: number | null;
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

export type RetentionActivityDto = {
  timezone: string;
  analyticsDataAvailableFrom: string | null;
  requiresAction: RetentionMemberRowDto[];
  movement: Array<{ movement: RetentionMovement; count: number }>;
  cohorts: Array<{
    cohortMonth: string;
    cohortSize: number;
    suppressed: boolean;
    suppressReason: string | null;
    cells: Array<{
      monthOffset: number;
      retained: number;
      cohortSize: number;
      ratePct: number | null;
      suppressed: boolean;
      suppressReason: string | null;
      limitedHistoryCoverage: boolean;
      limitedHistoryReason: string | null;
    }>;
  }>;
  classStickiness: Array<{
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
  }>;
  frequencyTrend: Array<{
    month: string;
    attendances: number;
    uniqueAttending: number;
    visitsPerAttending: number | null;
    isPartial: boolean;
    isCurrentMonth: boolean;
  }>;
  limitedHistoryMessage: string | null;
};

export type RetentionMemberDetailDto = RetentionMemberRowDto & {
  monthlyTrend: Array<{ month: string; attendances: number; isPartial: boolean }>;
};

export function fetchRetentionSummary(studioId: string) {
  return apiRequest<RetentionSummaryDto>(`/studios/${studioId}/analytics/retention/summary`);
}

export function fetchRetentionActivity(studioId: string) {
  return apiRequest<RetentionActivityDto>(`/studios/${studioId}/analytics/retention/activity`);
}

export function fetchRetentionMembers(
  studioId: string,
  params: Record<string, string | number | undefined>,
) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs}` : "";
  return apiRequest<RetentionMembersDto>(
    `/studios/${studioId}/analytics/retention/members${suffix}`,
  );
}

export function fetchRetentionMemberDetail(studioId: string, userId: string) {
  return apiRequest<RetentionMemberDetailDto>(
    `/studios/${studioId}/analytics/retention/members/${userId}`,
  );
}
