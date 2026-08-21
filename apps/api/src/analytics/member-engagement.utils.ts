export type MemberEngagementStatusCode =
  | 'VERY_ACTIVE'
  | 'ACTIVE'
  | 'LOW_ACTIVITY'
  | 'AT_RISK'
  | 'INACTIVE';

export type ActivityLevel = 'VERY_ACTIVE' | 'ACTIVE' | 'LOW_ACTIVITY' | 'NONE';
export type EngagementHealth = 'HEALTHY' | 'WATCH' | 'AT_RISK' | 'INACTIVE';

export const MEMBER_ENGAGEMENT_STATUS_LABELS: Record<MemberEngagementStatusCode, string> = {
  VERY_ACTIVE: 'Muy activo',
  ACTIVE: 'Activo',
  LOW_ACTIVITY: 'Baja actividad',
  AT_RISK: 'En riesgo',
  INACTIVE: 'Inactivo',
};

export type MemberEngagementInput = {
  visitsLast30d: number;
  visitsPrior30d: number;
  daysSinceLastVisit: number | null;
  activeWeeksLast90d: number;
  isEntitled: boolean;
};

export type MemberEngagementResult = {
  status: MemberEngagementStatusCode;
  activityLevel: ActivityLevel;
  health: EngagementHealth;
  reasons: string[];
  trendPct: number | null;
};

const MIN_BASELINE_VISITS = 4;
const SIGNIFICANT_DECLINE_PCT = 40;

export function computePersonalTrendPct(
  visitsLast30d: number,
  visitsPrior30d: number,
): number | null {
  if (visitsPrior30d < MIN_BASELINE_VISITS) return null;
  return Math.round(((visitsLast30d - visitsPrior30d) / visitsPrior30d) * 100);
}

export function classifyActivityLevel(visitsLast30d: number): ActivityLevel {
  if (visitsLast30d >= 8) return 'VERY_ACTIVE';
  if (visitsLast30d >= 4) return 'ACTIVE';
  if (visitsLast30d >= 1) return 'LOW_ACTIVITY';
  return 'NONE';
}

/** Retention health for currently entitled members; never AT_RISK for lapsed members. */
export function classifyEngagementHealth(input: MemberEngagementInput): {
  health: EngagementHealth;
  reasons: string[];
  trendPct: number | null;
} {
  const trendPct = computePersonalTrendPct(input.visitsLast30d, input.visitsPrior30d);
  const reasons: string[] = [];

  if (!input.isEntitled) {
    return { health: 'INACTIVE', reasons: ['Membresía no activa'], trendPct: null };
  }

  if (input.daysSinceLastVisit === null) {
    return { health: 'INACTIVE', reasons: ['Sin visitas registradas'], trendPct: null };
  }

  if (input.daysSinceLastVisit >= 30) {
    reasons.push(`Última visita hace ${input.daysSinceLastVisit} días`);
    return { health: 'INACTIVE', reasons, trendPct };
  }

  if (input.daysSinceLastVisit >= 14) {
    reasons.push(`Última visita hace ${input.daysSinceLastVisit} días`);
    return { health: 'AT_RISK', reasons, trendPct };
  }

  if (trendPct !== null && trendPct <= -SIGNIFICANT_DECLINE_PCT) {
    reasons.push(`Frecuencia ↓${Math.abs(trendPct)}% vs. sus 30 días anteriores`);
    return { health: 'AT_RISK', reasons, trendPct };
  }

  if (input.visitsLast30d === 0) {
    return { health: 'INACTIVE', reasons: ['Sin visitas en los últimos 30 días'], trendPct };
  }

  return { health: 'HEALTHY', reasons, trendPct };
}

export function combineEngagementStatus(
  health: EngagementHealth,
  activity: ActivityLevel,
  isEntitled: boolean,
): MemberEngagementStatusCode {
  if (!isEntitled) {
    if (activity === 'VERY_ACTIVE' || activity === 'ACTIVE') return activity;
    if (activity === 'LOW_ACTIVITY') return 'LOW_ACTIVITY';
    return 'INACTIVE';
  }

  if (health === 'AT_RISK') return 'AT_RISK';
  if (health === 'INACTIVE') return 'INACTIVE';
  if (activity === 'VERY_ACTIVE') return 'VERY_ACTIVE';
  if (activity === 'ACTIVE') return 'ACTIVE';
  if (activity === 'LOW_ACTIVITY') return 'LOW_ACTIVITY';
  return 'INACTIVE';
}

export function classifyMemberEngagement(input: MemberEngagementInput): MemberEngagementResult {
  const activityLevel = classifyActivityLevel(input.visitsLast30d);
  const { health, reasons, trendPct } = classifyEngagementHealth(input);
  return {
    status: combineEngagementStatus(health, activityLevel, input.isEntitled),
    activityLevel,
    health,
    reasons,
    trendPct,
  };
}

/** Requires-attention candidates: entitled members with retention risk only. */
export function isRequiresAttentionCandidate(result: MemberEngagementResult, isEntitled: boolean): boolean {
  return isEntitled && (result.health === 'AT_RISK' || result.health === 'INACTIVE');
}

export function computeVisitsPerWeek(visits: number, days: number): number {
  if (days <= 0 || visits <= 0) return 0;
  return Math.round((visits / (days / 7)) * 10) / 10;
}

export function frequencyBucket(visits: number): string {
  if (visits === 0) return '0';
  if (visits <= 3) return '1-3';
  if (visits <= 7) return '4-7';
  if (visits <= 11) return '8-11';
  if (visits <= 15) return '12-15';
  return '16+';
}
