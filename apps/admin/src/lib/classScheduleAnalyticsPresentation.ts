import type { ClassDemandBand, SlotMaturity } from "@/lib/api/class-schedule-analytics";

export const WEEKDAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;
export const WEEKDAY_FULL = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
] as const;

/** Mon→Sun display order for limited-history grouping. */
export const WEEKDAY_ORDER_MON_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;

export const SAMPLE_INSUFFICIENT_LABEL = "Muestra insuficiente";

export const LIMITED_HISTORY_FOOTNOTE =
  "Estas sesiones sí forman parte de los KPIs generales, pero todavía no tienen suficiente historial para comparar el rendimiento del horario.";

export const BAND_LABELS: Record<ClassDemandBand, string> = {
  ALTA: "Alta demanda",
  FUERTE: "Fuerte",
  NORMAL: "Normal",
  BAJA: "Baja demanda",
  INSUFICIENTE: SAMPLE_INSUFFICIENT_LABEL,
};

export const BAND_CLASS: Record<ClassDemandBand, string> = {
  ALTA: "bg-emerald-50 text-emerald-800",
  FUERTE: "bg-emerald-50/70 text-emerald-800",
  NORMAL: "bg-zinc-100 text-zinc-700",
  BAJA: "bg-amber-50 text-amber-900",
  INSUFICIENTE: "bg-zinc-50 text-zinc-500",
};

export const PERIOD_OPTIONS = [
  { value: "last_7d", label: "Últimos 7 días" },
  { value: "last_30d", label: "Últimos 30 días" },
  { value: "last_90d", label: "Últimos 90 días" },
  { value: "this_month", label: "Este mes" },
  { value: "prev_month", label: "Mes anterior" },
] as const;

export function formatSlot(weekday: number, time: string): string {
  return `${WEEKDAY_SHORT[weekday] ?? weekday} · ${time}`;
}

export function formatPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n}%`;
}

export function formatNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return String(n);
}

/**
 * Demand intensity for avg attendance — monochromatic, not moral judgment.
 * 0 → empty, ~1 subtle, ~2 clear, 3+ strong.
 */
export function heatmapIntensity(value: number | null, _max?: number): number {
  if (value == null || value <= 0) return 0;
  if (value < 1) return 0.18 + value * 0.12;
  if (value < 2) return 0.32 + (value - 1) * 0.22;
  if (value < 3) return 0.54 + (value - 2) * 0.22;
  return Math.min(0.92, 0.76 + (value - 3) * 0.08);
}

export function opportunityAccent(signalKind: string): string {
  switch (signalKind) {
    case "FORTALEZA":
      return "border-l-emerald-600";
    case "REVISAR":
    case "ALERTA":
      return "border-l-amber-500";
    default:
      return "border-l-zinc-400";
  }
}

export type LimitedHistorySlotLike = {
  weekday: number;
  scheduleTime: string;
  scheduledSessions: number;
};

export type LimitedHistoryWeekdayGroup<T extends LimitedHistorySlotLike> = {
  weekday: number;
  label: string;
  items: T[];
};

/** Group limited-history slots by weekday (Mon→Sun), times ascending, exact HH:MM preserved. */
export function groupLimitedHistoryByWeekday<T extends LimitedHistorySlotLike>(
  slots: T[],
): LimitedHistoryWeekdayGroup<T>[] {
  const by = new Map<number, T[]>();
  for (const s of slots) {
    const list = by.get(s.weekday) ?? [];
    list.push(s);
    by.set(s.weekday, list);
  }
  for (const list of by.values()) {
    list.sort((a, b) => a.scheduleTime.localeCompare(b.scheduleTime));
  }
  return WEEKDAY_ORDER_MON_FIRST.filter((d) => by.has(d)).map((weekday) => ({
    weekday,
    label: WEEKDAY_FULL[weekday] ?? String(weekday),
    items: by.get(weekday)!,
  }));
}

export type DrawerSlotLike = {
  slotMaturity: SlotMaturity;
  avgAttendance: number | null;
};

/**
 * Evidence-first drawer ordering: ESTABLISHED before LIMITED, then by avg attendance desc.
 * Does not hide high limited averages — only demotes their section.
 */
export function partitionDrawerSlotsByMaturity<T extends DrawerSlotLike>(slots: T[]): {
  established: T[];
  limited: T[];
} {
  const byAvgDesc = (a: T, b: T) => (b.avgAttendance ?? -1) - (a.avgAttendance ?? -1);
  return {
    established: slots.filter((s) => s.slotMaturity === "ESTABLISHED_SLOT").sort(byAvgDesc),
    limited: slots.filter((s) => s.slotMaturity !== "ESTABLISHED_SLOT").sort(byAvgDesc),
  };
}
