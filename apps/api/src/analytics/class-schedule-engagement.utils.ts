/** Sample gates for Analytics 1.2 recommendations / rankings. */
export const SLOT_RECOMMENDATION_MIN_SESSIONS = 4;
export const CLASS_TIME_COMPARE_MIN_SESSIONS = 3;
export const CLASS_RANKING_MIN_ACTIVE_SESSIONS = 5;

/** Relative demand bands use avg attendance (not capacity %). */
export const HIGH_DEMAND_AVG_ATT = 3.0;
export const STRONG_AVG_ATT = 2.5;
export const LOW_DEMAND_AVG_ATT = 1.2;

export type ClassDemandBand = 'ALTA' | 'FUERTE' | 'NORMAL' | 'BAJA' | 'INSUFICIENTE';

export type ClassScheduleOpportunityType =
  | 'STRONG_SLOT'
  | 'REVIEW_LOW_DEMAND'
  | 'COMPARE_CLASS_TIME'
  | 'HIGH_MISS_RATE';

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
};

export function isActiveSession(s: SessionFact): boolean {
  return s.attendances > 0 || s.confirmedBookings > 0;
}

export function isEmptySession(s: SessionFact): boolean {
  return s.attendances === 0 && s.confirmedBookings === 0;
}

export type BuiltOpportunity = {
  type: ClassScheduleOpportunityType;
  title: string;
  reason: string;
  evidence: string;
  sampleSize: number;
  suggestedAction: string;
  classTemplateId: string | null;
  className: string | null;
  weekday: number | null;
  scheduleTime: string | null;
  rankScore: number;
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
    if (slot.scheduledSessions < SLOT_RECOMMENDATION_MIN_SESSIONS) continue;
    const avg = slot.avgAttendance;
    if (avg == null) continue;

    if (avg >= STRONG_AVG_ATT) {
      out.push({
        type: 'STRONG_SLOT',
        title: 'Horario fuerte',
        reason: `${formatSlotLabel(slot.weekday, slot.scheduleTime)} concentra asistencia consistente.`,
        evidence: `${formatSlotLabel(slot.weekday, slot.scheduleTime)} promedia ${round1(avg)} asistencias por sesión en ${slot.scheduledSessions} sesiones (${slot.activeSessions} con actividad).`,
        sampleSize: slot.scheduledSessions,
        suggestedAction: 'Protege este bloque al ajustar el calendario.',
        classTemplateId: null,
        className: null,
        weekday: slot.weekday,
        scheduleTime: slot.scheduleTime,
        rankScore: 100 + avg * 10 + slot.scheduledSessions,
      });
    }

    const emptyRate = slot.emptyRatePct ?? 0;
    if (avg <= LOW_DEMAND_AVG_ATT && emptyRate >= 40) {
      out.push({
        type: 'REVIEW_LOW_DEMAND',
        title: 'Revisar baja demanda',
        reason: `${formatSlotLabel(slot.weekday, slot.scheduleTime)} muestra poca asistencia y muchas sesiones vacías.`,
        evidence: `${formatSlotLabel(slot.weekday, slot.scheduleTime)}: ${round1(avg)} asist./sesión · ${roundPct(emptyRate)}% vacías · n=${slot.scheduledSessions}.`,
        sampleSize: slot.scheduledSessions,
        suggestedAction: 'Revisa frecuencia, horario o formato antes de agregar más sesiones.',
        classTemplateId: null,
        className: null,
        weekday: slot.weekday,
        scheduleTime: slot.scheduleTime,
        rankScore: 80 + emptyRate + (LOW_DEMAND_AVG_ATT - avg) * 10,
      });
    }
  }

  // Class × time: same class, two slots with enough sample and clear gap
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
      title: 'La clase depende del horario',
      reason: `${best.className} rinde distinto según el bloque horario.`,
      evidence: `${best.className}: ${formatSlotLabel(best.weekday, best.scheduleTime)} promedia ${round1(best.avgAttendance)} (n=${best.activeSessions}) vs ${formatSlotLabel(worst.weekday, worst.scheduleTime)} ${round1(worst.avgAttendance)} (n=${worst.activeSessions}).`,
      sampleSize: Math.min(best.activeSessions, worst.activeSessions),
      suggestedAction: 'Prioriza el bloque más fuerte al planear la semana.',
      classTemplateId: best.classTemplateId,
      className: best.className,
      weekday: best.weekday,
      scheduleTime: best.scheduleTime,
      rankScore: 90 + gap * 15,
    });
  }

  // High miss rate on slots with enough bookings
  if (input.studioShowRatePct != null) {
    for (const slot of input.slots) {
      if (slot.confirmedBookings < 15 || slot.showRatePct == null) continue;
      if (slot.showRatePct > input.studioShowRatePct - 15) continue;
      out.push({
        type: 'HIGH_MISS_RATE',
        title: 'Reservas sin check-in elevadas',
        reason: `${formatSlotLabel(slot.weekday, slot.scheduleTime)} tiene más reservas sin asistencia que el promedio del estudio.`,
        evidence: `Show rate ${roundPct(slot.showRatePct)}% vs estudio ${roundPct(input.studioShowRatePct)}% · ${slot.confirmedBookings} reservas confirmadas.`,
        sampleSize: slot.confirmedBookings,
        suggestedAction: 'Revisa recordatorios o la fricción de asistencia en este horario.',
        classTemplateId: null,
        className: null,
        weekday: slot.weekday,
        scheduleTime: slot.scheduleTime,
        rankScore: 70 + (input.studioShowRatePct - slot.showRatePct),
      });
    }
  }

  // Diversify by type first (prefer one of each), then fill by score. Cap at 6.
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
  // Round-robin across types so STRONG_SLOT is not crowded out by many REVIEW cards
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
