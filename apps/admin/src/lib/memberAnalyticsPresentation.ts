import type { MemberEngagementStatusCode } from "@/lib/api/member-analytics";

export const ENGAGEMENT_STATUS_LABELS: Record<MemberEngagementStatusCode, string> = {
  VERY_ACTIVE: "Muy activo",
  ACTIVE: "Activo",
  LOW_ACTIVITY: "Baja actividad",
  AT_RISK: "En riesgo",
  INACTIVE: "Inactivo",
};

export const ENGAGEMENT_STATUS_CLASS: Record<MemberEngagementStatusCode, string> = {
  VERY_ACTIVE: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  ACTIVE: "bg-sky-50 text-sky-800 ring-sky-200",
  LOW_ACTIVITY: "bg-amber-50 text-amber-800 ring-amber-200",
  AT_RISK: "bg-orange-50 text-orange-800 ring-orange-200",
  INACTIVE: "bg-zinc-100 text-zinc-600 ring-zinc-200",
};

export const WEEKDAY_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

export function formatTrendPct(value: number | null): string {
  if (value === null) return "—";
  if (value > 0) return `↑ +${value}%`;
  if (value < 0) return `↓ ${value}%`;
  return "0%";
}

export function formatLastVisit(iso: string | null): string {
  if (!iso) return "Sin visitas";
  const date = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (diffDays <= 0) return "Hoy";
  if (diffDays === 1) return "Ayer";
  if (diffDays < 7) return `Hace ${diffDays} d`;
  return new Intl.DateTimeFormat("es-MX", { month: "short", day: "numeric" }).format(date);
}

export function formatDecimal(value: number | null, digits = 1): string {
  if (value === null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function memberInitials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

export function formatFavoriteScheduleTime(time: string | null): string {
  if (!time) return "—";
  if (time.endsWith(":00")) return time;
  return time;
}

export function formatFavoriteWeekday(weekday: number | null): string {
  if (weekday == null) return "—";
  return WEEKDAY_LABELS[weekday] ?? "—";
}
