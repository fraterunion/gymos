import {
  classifyEngagementHealth,
  classifyMemberEngagement,
  computePersonalTrendPct,
  type EngagementHealth,
  type MemberEngagementInput,
  type MemberEngagementResult,
} from './member-engagement.utils';

/** Retention-facing health (maps WATCH → OBSERVATION for UI). */
export type RetentionHealth = 'HEALTHY' | 'OBSERVATION' | 'AT_RISK' | 'INACTIVE' | 'LAPSED';

export type RetentionMovement =
  | 'MEJORANDO'
  | 'ESTABLE'
  | 'BAJANDO'
  | 'EN_RIESGO'
  | 'RECUPERADO'
  | 'SIN_ACTIVIDAD'
  | 'MEMBRESIA_FINALIZADA'
  | 'SIN_BASELINE';

export type RetentionSuggestedAction =
  | 'CONTACTAR'
  | 'DAR_SEGUIMIENTO'
  | 'REVISAR_MEMBRESIA'
  | 'FELICITAR_REGRESO'
  | 'SIN_ACCION';

export const RETENTION_HEALTH_LABELS: Record<RetentionHealth, string> = {
  HEALTHY: 'Saludable',
  OBSERVATION: 'En observación',
  AT_RISK: 'En riesgo',
  INACTIVE: 'Sin actividad',
  LAPSED: 'Membresía finalizada',
};

export const RETENTION_MOVEMENT_LABELS: Record<RetentionMovement, string> = {
  MEJORANDO: 'Mejorando',
  ESTABLE: 'Estable',
  BAJANDO: 'Bajando',
  EN_RIESGO: 'En riesgo',
  RECUPERADO: 'Recuperado',
  SIN_ACTIVIDAD: 'Sin actividad',
  MEMBRESIA_FINALIZADA: 'Membresía finalizada',
  SIN_BASELINE: 'Sin historial suficiente',
};

export const RETENTION_ACTION_LABELS: Record<RetentionSuggestedAction, string> = {
  CONTACTAR: 'Contactar',
  DAR_SEGUIMIENTO: 'Dar seguimiento',
  REVISAR_MEMBRESIA: 'Revisar membresía',
  FELICITAR_REGRESO: 'Felicitar regreso',
  SIN_ACCION: 'Sin acción',
};

/** Minimum unique seed members to show class return rates. */
export const CLASS_STICKINESS_MIN_SAMPLE = 5;

/** Minimum join-month cohort size to show percentages. */
export const COHORT_MIN_SIZE = 10;

/** Gap (studio-local calendar days) required before a return can count as recovery. */
export const RECOVERY_MIN_GAP_DAYS = 14;

/** Minimum attendances after return to count as recovered. */
export const RECOVERY_MIN_VISITS_30D = 2;

/** Preferencias need ≥3 supporting attendances before saying "normalmente". */
export const PATTERN_PREFERENCE_MIN_EVIDENCE = 3;

const HEALTH_RANK: Record<EngagementHealth, number> = {
  HEALTHY: 3,
  WATCH: 2,
  AT_RISK: 1,
  INACTIVE: 0,
};

export function toRetentionHealth(
  engagement: MemberEngagementResult,
  isEntitled: boolean,
): RetentionHealth {
  if (!isEntitled) return 'LAPSED';
  if (engagement.health === 'WATCH') return 'OBSERVATION';
  if (engagement.health === 'AT_RISK') return 'AT_RISK';
  if (engagement.health === 'INACTIVE') return 'INACTIVE';
  return 'HEALTHY';
}

export function classifyPriorWindowHealth(input: {
  visitsPrior30d: number;
  visits60to90d: number;
  daysSinceLastVisitAtPriorEnd: number | null;
  isEntitled: boolean;
}): EngagementHealth {
  const { health } = classifyEngagementHealth({
    visitsLast30d: input.visitsPrior30d,
    visitsPrior30d: input.visits60to90d,
    daysSinceLastVisit: input.daysSinceLastVisitAtPriorEnd,
    activeWeeksLast90d: 0,
    isEntitled: input.isEntitled,
  });
  return health;
}

export type RecoveredAssessment = {
  isRecovered: boolean;
  reasons: string[];
  gapDays: number | null;
  visitsSinceReturn: number | null;
};

/**
 * Conservative recovery: gap ≥14 studio-local calendar days, ≥2 visits since return,
 * healthy recent recency, currently entitled. One-visit bounce ≠ recovered.
 */
export function assessRecovered(input: {
  isEntitled: boolean;
  visits30d: number;
  daysSinceLastVisit: number | null;
  priorHealth: EngagementHealth;
  gapDaysBeforeReturn: number | null;
  visitsSinceReturn: number | null;
  currentHealth: EngagementHealth;
}): RecoveredAssessment {
  if (!input.isEntitled) {
    return { isRecovered: false, reasons: [], gapDays: null, visitsSinceReturn: null };
  }

  const gapOk =
    input.gapDaysBeforeReturn != null && input.gapDaysBeforeReturn >= RECOVERY_MIN_GAP_DAYS;
  const visitsOk = input.visits30d >= RECOVERY_MIN_VISITS_30D;
  const sinceReturnOk =
    input.visitsSinceReturn != null && input.visitsSinceReturn >= RECOVERY_MIN_VISITS_30D;
  const recencyOk = input.daysSinceLastVisit != null && input.daysSinceLastVisit < 14;
  const currentOk = input.currentHealth === 'HEALTHY' || input.currentHealth === 'WATCH';

  if (!(gapOk && visitsOk && sinceReturnOk && recencyOk && currentOk)) {
    return {
      isRecovered: false,
      reasons: [],
      gapDays: input.gapDaysBeforeReturn,
      visitsSinceReturn: input.visitsSinceReturn,
    };
  }

  return {
    isRecovered: true,
    reasons: [
      `Regresó después de ${input.gapDaysBeforeReturn} días sin asistir`,
      `${input.visitsSinceReturn} visitas desde su regreso`,
    ],
    gapDays: input.gapDaysBeforeReturn,
    visitsSinceReturn: input.visitsSinceReturn,
  };
}

export function classifyMovement(input: {
  isEntitled: boolean;
  isRecovered: boolean;
  currentHealth: EngagementHealth;
  priorHealth: EngagementHealth;
  trendPct: number | null;
  /** When prior windows have no attendance history. */
  insufficientPriorHistory?: boolean;
}): RetentionMovement {
  if (!input.isEntitled) return 'MEMBRESIA_FINALIZADA';
  if (input.isRecovered) return 'RECUPERADO';
  if (input.currentHealth === 'INACTIVE') return 'SIN_ACTIVIDAD';
  if (input.currentHealth === 'AT_RISK') return 'EN_RIESGO';

  if (input.insufficientPriorHistory) {
    return 'SIN_BASELINE';
  }

  const cur = HEALTH_RANK[input.currentHealth];
  const prior = HEALTH_RANK[input.priorHealth];

  if (cur > prior) return 'MEJORANDO';
  if (cur < prior) return 'BAJANDO';

  if (input.trendPct != null && input.trendPct >= 40) return 'MEJORANDO';
  if (input.trendPct != null && input.trendPct <= -20) return 'BAJANDO';
  return 'ESTABLE';
}

export function suggestRetentionAction(input: {
  isEntitled: boolean;
  isRecovered: boolean;
  health: RetentionHealth;
  movement: RetentionMovement;
  daysSinceLastVisit: number | null;
  entitlementEndsAt: Date | null;
  now: Date;
}): RetentionSuggestedAction {
  if (!input.isEntitled) return 'SIN_ACCION';
  if (input.isRecovered) return 'FELICITAR_REGRESO';

  if (
    input.entitlementEndsAt != null &&
    input.entitlementEndsAt.getTime() - input.now.getTime() <= 7 * 86_400_000 &&
    input.entitlementEndsAt.getTime() >= input.now.getTime()
  ) {
    return 'REVISAR_MEMBRESIA';
  }

  if (input.health === 'INACTIVE') return 'CONTACTAR';
  if (input.health === 'AT_RISK') {
    if (input.daysSinceLastVisit != null && input.daysSinceLastVisit >= 21) return 'CONTACTAR';
    return 'DAR_SEGUIMIENTO';
  }
  if (input.health === 'OBSERVATION' || input.movement === 'BAJANDO') return 'DAR_SEGUIMIENTO';
  return 'SIN_ACCION';
}

/**
 * Higher = more urgent for Requires Action sort.
 * Order: INACTIVE > AT_RISK > OBSERVATION > RECOVERED (never above risk).
 */
export function retentionActionPriority(input: {
  health: RetentionHealth;
  daysSinceLastVisit: number | null;
  trendPct: number | null;
  isRecovered: boolean;
}): number {
  if (input.isRecovered) return 5;
  let score = 0;
  if (input.health === 'INACTIVE') score += 50;
  if (input.health === 'AT_RISK') score += 30;
  if (input.health === 'OBSERVATION') score += 10;
  score += (input.daysSinceLastVisit ?? 0) * 2;
  if (input.trendPct != null && input.trendPct < 0) score += Math.abs(input.trendPct);
  return score;
}

export function isRequiresActionRow(input: {
  isEntitled: boolean;
  health: RetentionHealth;
  isRecovered: boolean;
}): boolean {
  if (!input.isEntitled) return false;
  if (input.isRecovered) return true;
  return input.health === 'AT_RISK' || input.health === 'INACTIVE';
}

export function buildMemberPatternSentence(input: {
  favoriteWeekdays: number[];
  favoriteTime: string | null;
  daysSinceLastVisit: number | null;
  visits30d: number;
  visitsPrior30d: number;
  trendPct: number | null;
  /** Attendances supporting preference mode (e.g. visits90d). */
  preferenceEvidenceCount: number;
}): string {
  const weekdayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const parts: string[] = [];
  const strongPrefs = input.preferenceEvidenceCount >= PATTERN_PREFERENCE_MIN_EVIDENCE;

  if (strongPrefs && input.favoriteWeekdays.length > 0 && input.favoriteTime) {
    const days = input.favoriteWeekdays
      .slice(0, 2)
      .map((d) => weekdayNames[d] ?? String(d))
      .join(' y ');
    parts.push(`Normalmente entrena ${days} a las ${input.favoriteTime}.`);
  } else if (strongPrefs && input.favoriteWeekdays.length > 0) {
    const days = input.favoriteWeekdays
      .slice(0, 2)
      .map((d) => weekdayNames[d] ?? String(d))
      .join(' y ');
    parts.push(`Normalmente entrena ${days}.`);
  } else if (input.favoriteTime) {
    parts.push(`Horario más frecuente: ${input.favoriteTime}.`);
  } else if (input.favoriteWeekdays.length > 0) {
    const day = weekdayNames[input.favoriteWeekdays[0]!] ?? String(input.favoriteWeekdays[0]);
    parts.push(`Día más frecuente: ${day}.`);
  }

  if (input.visitsPrior30d > 0 && input.visits30d !== input.visitsPrior30d) {
    parts.push(`Su frecuencia pasó de ${input.visitsPrior30d} a ${input.visits30d} visitas.`);
  } else if (input.trendPct != null && input.trendPct <= -40) {
    parts.push(`Su frecuencia bajó ${Math.abs(input.trendPct)}% vs. el periodo anterior.`);
  }

  if (input.daysSinceLastVisit != null && input.daysSinceLastVisit >= 7) {
    parts.push(`No ha asistido en ${input.daysSinceLastVisit} días.`);
  } else if (input.daysSinceLastVisit === null) {
    parts.push('Sin visitas registradas.');
  }

  return parts.join(' ') || 'Sin patrón de asistencia suficiente para resumir.';
}

export function classifyRetentionMember(input: MemberEngagementInput & {
  visits60to90d: number;
  daysSinceLastVisitAtPriorEnd: number | null;
  gapDaysBeforeReturn: number | null;
  visitsSinceReturn: number | null;
}): {
  engagement: MemberEngagementResult;
  retentionHealth: RetentionHealth;
  priorHealth: EngagementHealth;
  recovered: RecoveredAssessment;
  movement: RetentionMovement;
  trendPct: number | null;
} {
  const engagement = classifyMemberEngagement(input);
  const priorHealth = classifyPriorWindowHealth({
    visitsPrior30d: input.visitsPrior30d,
    visits60to90d: input.visits60to90d,
    daysSinceLastVisitAtPriorEnd: input.daysSinceLastVisitAtPriorEnd,
    isEntitled: input.isEntitled,
  });
  const recovered = assessRecovered({
    isEntitled: input.isEntitled,
    visits30d: input.visitsLast30d,
    daysSinceLastVisit: input.daysSinceLastVisit,
    priorHealth,
    gapDaysBeforeReturn: input.gapDaysBeforeReturn,
    visitsSinceReturn: input.visitsSinceReturn,
    currentHealth: engagement.health,
  });
  const insufficientPriorHistory =
    input.visitsPrior30d === 0 && input.visits60to90d === 0;
  const movement = classifyMovement({
    isEntitled: input.isEntitled,
    isRecovered: recovered.isRecovered,
    currentHealth: engagement.health,
    priorHealth,
    trendPct: engagement.trendPct,
    insufficientPriorHistory,
  });

  return {
    engagement,
    retentionHealth: toRetentionHealth(engagement, input.isEntitled),
    priorHealth,
    recovered,
    movement,
    trendPct: engagement.trendPct ?? computePersonalTrendPct(input.visitsLast30d, input.visitsPrior30d),
  };
}
