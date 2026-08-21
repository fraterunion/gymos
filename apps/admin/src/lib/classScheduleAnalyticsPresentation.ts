import type { ClassDemandBand } from "@/lib/api/class-schedule-analytics";

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

export const BAND_LABELS: Record<ClassDemandBand, string> = {
  ALTA: "Alta demanda",
  FUERTE: "Fuerte",
  NORMAL: "Normal",
  BAJA: "Baja demanda",
  INSUFICIENTE: "Muestra insuficiente",
};

export const BAND_CLASS: Record<ClassDemandBand, string> = {
  ALTA: "bg-emerald-50 text-emerald-800",
  FUERTE: "bg-sky-50 text-sky-800",
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

export function heatmapIntensity(value: number | null, max: number): number {
  if (value == null || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}
