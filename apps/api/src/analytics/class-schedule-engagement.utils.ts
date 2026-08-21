import { getStudioLocalWeekStartKey } from './member-analytics-schedule.utils';

/** Sample gates for Analytics 1.2 recommendations / rankings. */
export const SLOT_RECOMMENDATION_MIN_SESSIONS = 4;
export const CLASS_TIME_COMPARE_MIN_SESSIONS = 3;
export const CLASS_RANKING_MIN_ACTIVE_SESSIONS = 5;

/** Analytical maturity for executive schedule slots (not operational truth). */
export const ESTABLISHED_SLOT_MIN_SESSIONS = 4;
export const ESTABLISHED_SLOT_MIN_DISTINCT_WEEKS = 4;

/** Relative demand bands use avg attendance (not capacity %). */
export const HIGH_DEMAND_AVG_ATT = 3.0;
export const STRONG_AVG_ATT = 2.5;
export const LOW_DEMAND_AVG_ATT = 1.2;

export type ClassDemandBand = 'ALTA' | 'FUERTE' | 'NORMAL' | 'BAJA' | 'INSUFICIENTE';

export type SlotMaturity = 'ESTABLISHED_SLOT' | 'LIMITED_HISTORY_SLOT';

export type ClassScheduleOpportunityType =
  | 'STRONG_SLOT'
  | 'REVIEW_LOW_DEMAND'
  | 'COMPARE_CLASS_TIME'
  | 'HIGH_MISS_RATE';

export type OpportunitySignalKind = 'FORTALEZA' | 'REVISAR' | 'COMPARACION' | 'ALERTA';

export type ClassScheduleHeatmapMetric =
  | 'avg_attendance'
  | 'attendance_occupancy'
  | 'booking_occupancy';

export const WEEKDAY_LABELS_ES = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
] as const;

export const WEEKDAY_SHORT_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'] as const;

export const SAMPLE_INSUFFICIENT_LABEL = 'Muestra insuficiente';

export function round1(n: number | null | undefined): number | null {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

export function roundPct(n: number | null | undefined): number | null {
  if (n == null || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

export function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return roundPct((numerator / denominator) * 100);
}

/**
 * Show rate: confirmed bookings that produced attendance / still-CONFIRMED bookings.
 * Cancelled bookings and walk-ins are excluded from the denominator.
 */
export function computeShowRatePct(
  confirmedAttended: number,
  confirmedBookings: number,
): number | null {
  return pct(confirmedAttended, confirmedBookings);
}

export function classifyDemandBand(input: {
  avgAttendance: number | null;
  sampleSize: number;
  minSample?: number;
}): ClassDemandBand {
  const min = input.minSample ?? SLOT_RECOMMENDATION_MIN_SESSIONS;
  if (input.sampleSize < min || input.avgAttendance == null) return 'INSUFICIENTE';
  if (input.avgAttendance >= HIGH_DEMAND_AVG_ATT) return 'ALTA';
  if (input.avgAttendance >= STRONG_AVG_ATT) return 'FUERTE';
  if (input.avgAttendance <= LOW_DEMAND_AVG_ATT) return 'BAJA';
  return 'NORMAL';
}

/**
 * Executive schedule maturity: enough sessions across enough distinct studio-local weeks.
 * Never rounds HH:MM. Template linkage is optional and not required.
 */
export function classifySlotMaturity(input: {
  eligibleSessionCount: number;
  distinctLocalWeekCount: number;
}): SlotMaturity {
  if (
    input.eligibleSessionCount >= ESTABLISHED_SLOT_MIN_SESSIONS &&
    input.distinctLocalWeekCount >= ESTABLISHED_SLOT_MIN_DISTINCT_WEEKS
  ) {
    return 'ESTABLISHED_SLOT';
  }
  return 'LIMITED_HISTORY_SLOT';
}

export function countDistinctLocalWeeks(
  startsAtList: Date[],
  timezone: string,
): number {
  const weeks = new Set(startsAtList.map((d) => getStudioLocalWeekStartKey(d, timezone)));
  return weeks.size;
}

export function formatSlotLabel(weekday: number, scheduleTime: string): string {
  const day = WEEKDAY_SHORT_ES[weekday] ?? String(weekday);
  return `${day} · ${scheduleTime}`;
}

export type SessionFact = {
  scheduledClassId: string;
  classTemplateId: string;
  className: string;
  capacity: number;
  startsAt: Date;
  weekday: number;
  scheduleTime: string;
  hour: number;
  attendances: number;
  confirmedBookings: number;
  confirmedAttended: number;
  /** Studio-local Monday-start week key (YYYY-MM-DD). */
  localWeekStartKey: string;
};

export function isActiveSession(s: SessionFact): boolean {
  return s.attendances > 0 || s.confirmedBookings > 0;
}

export function isEmptySession(s: SessionFact): boolean {
  return s.attendances === 0 && s.confirmedBookings === 0;
}

export type BuiltOpportunity = {
  type: ClassScheduleOpportunityType;
  signalKind: OpportunitySignalKind;
  title: string;
  subject: string;
  headlineMetric: string;
  supportingMetric: string;
  suggestedAction: string;
  sampleSize: number;
  classTemplateId: string | null;
  className: string | null;
  weekday: number | null;
  scheduleTime: string | null;
  rankScore: number;
  /** @deprecated kept for transitional clients — mirrors headline + supporting */
  reason: string;
  evidence: string;
};

export function buildOpportunities(input: {
  slots: Array<{
    weekday: number;
    scheduleTime: string;
    scheduledSessions: number;
    activeSessions: number;
    emptySessions: number;
    emptyRatePct: number | null;
    avgAttendance: number | null;
    showRatePct: number | null;
    confirmedBookings: number;
    slotMaturity: SlotMaturity;
  }>;
  classSlots: Array<{
    classTemplateId: string;
    className: string;
    weekday: number;
    scheduleTime: string;
    sessions: number;
    activeSessions: number;
    avgAttendance: number | null;
  }>;
  studioShowRatePct: number | null;
}): BuiltOpportunity[] {
  const out: BuiltOpportunity[] = [];

  for (const slot of input.slots) {
    // Strategic slot recommendations require established maturity
    if (slot.slotMaturity !== 'ESTABLISHED_SLOT') continue;
    if (slot.scheduledSessions < SLOT_RECOMMENDATION_MIN_SESSIONS) continue;
    const avg = slot.avgAttendance;
    if (avg == null) continue;
    const label = formatSlotLabel(slot.weekday, slot.scheduleTime);
    const sampleLine = `${slot.scheduledSessions} sesiones analizadas`;

    if (avg >= STRONG_AVG_ATT) {
      out.push({
        type: 'STRONG_SLOT',
        signalKind: 'FORTALEZA',
        title: 'FORTALEZA',
        subject: label,
        headlineMetric: `${round1(avg)} asistencias / sesión`,
        supportingMetric: sampleLine,
        suggestedAction: 'Protege este bloque al ajustar el calendario.',
        sampleSize: slot.scheduledSessions,
        classTemplateId: null,
        className: null,
        weekday: slot.weekday,
        scheduleTime: slot.scheduleTime,
        rankScore: 100 + avg * 10 + slot.scheduledSessions,
        reason: label,
        evidence: `${round1(avg)} asistencias / sesión · ${sampleLine}`,
      });
    }

    const emptyRate = slot.emptyRatePct ?? 0;
    if (avg <= LOW_DEMAND_AVG_ATT && emptyRate >= 40) {
      out.push({
        type: 'REVIEW_LOW_DEMAND',
        signalKind: 'REVISAR',
        title: 'REVISAR',
        subject: label,
        headlineMetric:
          avg === 0
            ? `${roundPct(emptyRate)}% sesiones vacías`
            : `${round1(avg)} asistencias / sesión`,
        supportingMetric:
          avg === 0
            ? sampleLine
            : `${roundPct(emptyRate)}% sesiones vacías · ${sampleLine}`,
        suggestedAction: 'Revisa frecuencia, horario o formato.',
        sampleSize: slot.scheduledSessions,
        classTemplateId: null,
        className: null,
        weekday: slot.weekday,
        scheduleTime: slot.scheduleTime,
        rankScore: 80 + emptyRate + (LOW_DEMAND_AVG_ATT - avg) * 10,
        reason: label,
        evidence: `${round1(avg)} asistencias / sesión · ${roundPct(emptyRate)}% vacías · ${sampleLine}`,
      });
    }
  }

  const byClass = new Map<string, typeof input.classSlots>();
  for (const row of input.classSlots) {
    const list = byClass.get(row.classTemplateId) ?? [];
    list.push(row);
    byClass.set(row.classTemplateId, list);
  }
  for (const [, rows] of byClass) {
    const eligible = rows.filter(
      (r) =>
        r.activeSessions >= CLASS_TIME_COMPARE_MIN_SESSIONS &&
        r.avgAttendance != null,
    );
    if (eligible.length < 2) continue;
    const sorted = [...eligible].sort(
      (a, b) => (b.avgAttendance ?? 0) - (a.avgAttendance ?? 0),
    );
    const best = sorted[0]!;
    const worst = sorted[sorted.length - 1]!;
    const gap = (best.avgAttendance ?? 0) - (worst.avgAttendance ?? 0);
    if (gap < 1.0) continue;
    out.push({
      type: 'COMPARE_CLASS_TIME',
      signalKind: 'COMPARACION',
      title: 'DEPENDE DEL HORARIO',
      subject: best.className,
      headlineMetric: `${best.scheduleTime} supera claramente a ${worst.scheduleTime}`,
      supportingMetric: `${round1(best.avgAttendance)} vs ${round1(worst.avgAttendance)} asistencias / sesión · n=${best.activeSessions} vs n=${worst.activeSessions}`,
      suggestedAction: 'Prioriza el bloque más fuerte al planear la semana.',
      sampleSize: Math.min(best.activeSessions, worst.activeSessions),
      classTemplateId: best.classTemplateId,
      className: best.className,
      weekday: best.weekday,
      scheduleTime: best.scheduleTime,
      rankScore: 90 + gap * 15,
      reason: best.className,
      evidence: `${formatSlotLabel(best.weekday, best.scheduleTime)} ${round1(best.avgAttendance)} vs ${formatSlotLabel(worst.weekday, worst.scheduleTime)} ${round1(worst.avgAttendance)}`,
    });
  }

  if (input.studioShowRatePct != null) {
    for (const slot of input.slots) {
      if (slot.slotMaturity !== 'ESTABLISHED_SLOT') continue;
      if (slot.confirmedBookings < 15 || slot.showRatePct == null) continue;
      if (slot.showRatePct > input.studioShowRatePct - 15) continue;
      const label = formatSlotLabel(slot.weekday, slot.scheduleTime);
      out.push({
        type: 'HIGH_MISS_RATE',
        signalKind: 'ALERTA',
        title: 'RESERVAS SIN CHECK-IN',
        subject: label,
        headlineMetric: `Show rate ${roundPct(slot.showRatePct)}%`,
        supportingMetric: `Estudio ${roundPct(input.studioShowRatePct)}% · ${slot.confirmedBookings} reservas confirmadas`,
        suggestedAction: 'Revisa recordatorios o la fricción de asistencia en este horario.',
        sampleSize: slot.confirmedBookings,
        classTemplateId: null,
        className: null,
        weekday: slot.weekday,
        scheduleTime: slot.scheduleTime,
        rankScore: 70 + (input.studioShowRatePct - slot.showRatePct),
        reason: label,
        evidence: `Show rate ${roundPct(slot.showRatePct)}% vs estudio ${roundPct(input.studioShowRatePct)}%`,
      });
    }
  }

  const byType = new Map<ClassScheduleOpportunityType, BuiltOpportunity[]>();
  for (const o of out.sort((a, b) => b.rankScore - a.rankScore)) {
    const list = byType.get(o.type) ?? [];
    list.push(o);
    byType.set(o.type, list);
  }
  const limited: BuiltOpportunity[] = [];
  const seen = new Set<string>();
  const pick = (o: BuiltOpportunity) => {
    const key = `${o.type}:${o.classTemplateId ?? ''}:${o.weekday ?? ''}:${o.scheduleTime ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    limited.push(o);
  };
  const typeOrder: ClassScheduleOpportunityType[] = [
    'STRONG_SLOT',
    'COMPARE_CLASS_TIME',
    'REVIEW_LOW_DEMAND',
    'HIGH_MISS_RATE',
  ];
  let depth = 0;
  while (limited.length < 6) {
    let added = false;
    for (const t of typeOrder) {
      const list = byType.get(t) ?? [];
      if (depth < list.length) {
        pick(list[depth]!);
        added = true;
        if (limited.length >= 6) break;
      }
    }
    if (!added) break;
    depth += 1;
  }
  return limited;
}

export function buildClassTimeInsight(input: {
  className: string;
  slots: Array<{
    weekday: number;
    scheduleTime: string;
    activeSessions: number;
    avgAttendance: number | null;
  }>;
}): { insight: string; evidence: string } | null {
  const eligible = input.slots.filter(
    (s) =>
      s.activeSessions >= CLASS_TIME_COMPARE_MIN_SESSIONS && s.avgAttendance != null,
  );
  if (eligible.length < 2) return null;
  const sorted = [...eligible].sort(
    (a, b) => (b.avgAttendance ?? 0) - (a.avgAttendance ?? 0),
  );
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;
  const gap = (best.avgAttendance ?? 0) - (worst.avgAttendance ?? 0);
  if (gap < 1.0) return null;
  return {
    insight: `${input.className} muestra mayor asistencia los ${WEEKDAY_LABELS_ES[best.weekday]?.toLowerCase() ?? best.weekday} a las ${best.scheduleTime} que a las ${worst.scheduleTime}.`,
    evidence: `${formatSlotLabel(best.weekday, best.scheduleTime)}: ${round1(best.avgAttendance)} asist./sesión (n=${best.activeSessions}) · ${formatSlotLabel(worst.weekday, worst.scheduleTime)}: ${round1(worst.avgAttendance)} (n=${worst.activeSessions}).`,
  };
}

export type OperationalReadingKind =
  | 'STRONG_CLASS'
  | 'SOFT_SHOW'
  | 'LOW_DEMAND_SLOT';

export type OperationalReading = {
  text: string;
  evidence: string;
  sampleSize: number;
  /** Structured key for deterministic UI dedupe vs Opportunities (not for display). */
  kind: OperationalReadingKind;
  className: string | null;
  weekday: number | null;
  scheduleTime: string | null;
};

export type OpportunityDedupeRef = {
  type: ClassScheduleOpportunityType;
  className: string | null;
  classTemplateId: string | null;
  weekday: number | null;
  scheduleTime: string | null;
};

/**
 * True when an Operational Reading would substantially repeat an Opportunity
 * already shown (same signal family + same subject grain). Deterministic only.
 */
export function operationalReadingOverlapsOpportunity(
  reading: Pick<
    OperationalReading,
    'kind' | 'className' | 'weekday' | 'scheduleTime'
  >,
  opportunity: OpportunityDedupeRef,
): boolean {
  if (reading.kind === 'LOW_DEMAND_SLOT' && opportunity.type === 'REVIEW_LOW_DEMAND') {
    if (
      reading.scheduleTime != null &&
      opportunity.scheduleTime != null &&
      reading.scheduleTime === opportunity.scheduleTime
    ) {
      // Same clock time covers "sesiones de las 20:00" vs "Lun · 20:00".
      if (
        reading.weekday == null ||
        opportunity.weekday == null ||
        reading.weekday === opportunity.weekday
      ) {
        return true;
      }
    }
  }

  if (reading.kind === 'SOFT_SHOW' && opportunity.type === 'HIGH_MISS_RATE') {
    if (
      reading.className != null &&
      opportunity.className != null &&
      reading.className === opportunity.className
    ) {
      return true;
    }
  }

  if (reading.kind === 'STRONG_CLASS' && opportunity.type === 'COMPARE_CLASS_TIME') {
    if (
      reading.className != null &&
      opportunity.className != null &&
      reading.className === opportunity.className
    ) {
      return true;
    }
  }

  return false;
}

function readingConflictsWithOpportunities(
  reading: Pick<
    OperationalReading,
    'kind' | 'className' | 'weekday' | 'scheduleTime'
  >,
  opportunities: OpportunityDedupeRef[],
): boolean {
  return opportunities.some((o) => operationalReadingOverlapsOpportunity(reading, o));
}

/**
 * Deterministic business observations (not action cards). Max 3.
 * Skips readings that duplicate already-built Opportunities.
 * No LLM. No capacity-expansion. No causal claims.
 */
export function buildOperationalReadings(input: {
  templates: Array<{
    className: string;
    activeSessions: number;
    attendances: number;
    avgAttendancePerActiveSession: number | null;
    showRatePct: number | null;
    sampleInsufficient: boolean;
    uniqueMembers: number;
  }>;
  slots: Array<{
    weekday: number;
    scheduleTime: string;
    scheduledSessions: number;
    emptyRatePct: number | null;
    avgAttendance: number | null;
    slotMaturity: SlotMaturity;
  }>;
  /** Pass Opportunities so Lectura operativa stays additive. */
  opportunities?: OpportunityDedupeRef[];
}): OperationalReading[] {
  const opportunities = input.opportunities ?? [];
  const out: OperationalReading[] = [];
  const max = 3;

  const ranked = input.templates
    .filter((t) => !t.sampleInsufficient && t.avgAttendancePerActiveSession != null)
    .sort(
      (a, b) =>
        (b.avgAttendancePerActiveSession ?? 0) - (a.avgAttendancePerActiveSession ?? 0),
    );

  const strongCandidates = ranked.filter(
    (t) =>
      (t.avgAttendancePerActiveSession ?? 0) >= STRONG_AVG_ATT &&
      t.showRatePct != null &&
      t.showRatePct >= 70,
  );
  for (const strongClass of strongCandidates) {
    if (out.length >= max) break;
    const candidate: OperationalReading = {
      kind: 'STRONG_CLASS',
      className: strongClass.className,
      weekday: null,
      scheduleTime: null,
      text: `${strongClass.className} combina demanda consistente con un show rate de ${roundPct(strongClass.showRatePct)}%.`,
      evidence: `${round1(strongClass.avgAttendancePerActiveSession)} asist./sesión activa · ${strongClass.activeSessions} sesiones activas · ${strongClass.attendances} asistencias`,
      sampleSize: strongClass.activeSessions,
    };
    if (!readingConflictsWithOpportunities(candidate, opportunities)) {
      out.push(candidate);
      break;
    }
  }

  const softCandidates = ranked.filter(
    (t) =>
      t.showRatePct != null &&
      t.showRatePct < 65 &&
      t.uniqueMembers >= 5 &&
      (t.avgAttendancePerActiveSession ?? 0) >= 1.5,
  );
  for (const softShow of softCandidates) {
    if (out.length >= max) break;
    const candidate: OperationalReading = {
      kind: 'SOFT_SHOW',
      className: softShow.className,
      weekday: null,
      scheduleTime: null,
      text: `${softShow.className} atrae miembros, pero su show rate de ${roundPct(softShow.showRatePct)}% deja margen para mejorar el cumplimiento de reservas.`,
      evidence: `${softShow.uniqueMembers} miembros únicos · ${softShow.activeSessions} sesiones activas`,
      sampleSize: softShow.activeSessions,
    };
    if (!readingConflictsWithOpportunities(candidate, opportunities)) {
      out.push(candidate);
      break;
    }
  }

  const weakSlots = input.slots
    .filter(
      (s) =>
        s.slotMaturity === 'ESTABLISHED_SLOT' &&
        (s.emptyRatePct ?? 0) >= 50 &&
        (s.avgAttendance ?? 0) <= LOW_DEMAND_AVG_ATT,
    )
    .sort((a, b) => (b.emptyRatePct ?? 0) - (a.emptyRatePct ?? 0));

  for (const weakEvening of weakSlots) {
    if (out.length >= max) break;
    const candidate: OperationalReading = {
      kind: 'LOW_DEMAND_SLOT',
      className: null,
      weekday: weakEvening.weekday,
      scheduleTime: weakEvening.scheduleTime,
      text: `Las sesiones de las ${weakEvening.scheduleTime} concentran baja demanda; revisa si la frecuencia actual está justificada.`,
      evidence: `${formatSlotLabel(weakEvening.weekday, weakEvening.scheduleTime)} · ${roundPct(weakEvening.emptyRatePct)}% vacías · ${round1(weakEvening.avgAttendance)} asist./sesión · ${weakEvening.scheduledSessions} sesiones`,
      sampleSize: weakEvening.scheduledSessions,
    };
    if (!readingConflictsWithOpportunities(candidate, opportunities)) {
      out.push(candidate);
      break;
    }
  }

  return out;
}
