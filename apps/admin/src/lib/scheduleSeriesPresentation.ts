import type { SeriesListItem, SeriesUiStatus } from "@/lib/api/scheduleSeries";

const WEEKDAY_SHORT_ES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;

export function seriesStatusLabel(status: SeriesUiStatus): string {
  switch (status) {
    case "ACTIVE":
      return "Activa";
    case "ENDING_SOON":
      return "Finaliza pronto";
    case "ENDED":
      return "Finalizada";
  }
}

export function seriesStatusTone(status: SeriesUiStatus): string {
  switch (status) {
    case "ACTIVE":
      return "bg-emerald-50 text-emerald-700 border-emerald-100";
    case "ENDING_SOON":
      return "bg-amber-50 text-amber-800 border-amber-100";
    case "ENDED":
      return "bg-zinc-100 text-zinc-600 border-zinc-200";
  }
}

export function formatFrequency(intervalWeeks: number): string {
  if (intervalWeeks === 1) return "Semanal";
  if (intervalWeeks === 2) return "Cada 2 semanas";
  return `Cada ${intervalWeeks} semanas`;
}

export function formatLocalDateShort(dateKey: string | null, tz: string): string {
  if (!dateKey) return "Horario histórico";
  const anchor = new Date(`${dateKey}T12:00:00Z`);
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: tz,
    day: "numeric",
    month: "short",
  }).format(anchor);
}

export function formatLocalDateRange(
  startsOn: string | null,
  endsOn: string | null,
  isLegacy: boolean,
  tz: string,
): string {
  const startLabel = isLegacy && !startsOn ? "Horario histórico" : formatLocalDateShort(startsOn, tz);
  if (!endsOn) return `Desde ${startLabel} · Sin fecha de fin`;
  const endLabel = formatLocalDateShort(endsOn, tz);
  if (isLegacy && !startsOn) return `Hasta ${endLabel}`;
  return `${startLabel} – ${endLabel}`;
}

export function formatOccurrenceInstant(iso: string, tz: string): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("es-MX", {
    timeZone: tz,
    day: "numeric",
    month: "short",
  }).format(d);
  const time = new Intl.DateTimeFormat("es-MX", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  return `${date} · ${time}`;
}

export function formatScheduleLine(item: Pick<SeriesListItem, "localSchedule">, tz: string): string {
  const weekday = WEEKDAY_SHORT_ES[item.localSchedule.weekday] ?? "—";
  return `${weekday} · ${item.localSchedule.startsAtLocal}`;
}

export function formatEndTimeLocal(
  startTime: string,
  durationMinutes: number,
): string {
  const [hh, mm] = startTime.split(":").map(Number);
  const total = (hh ?? 0) * 60 + (mm ?? 0) + durationMinutes;
  const endH = Math.floor(total / 60) % 24;
  const endM = total % 60;
  return `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}

export function occurrenceExceptionCopy(
  exception: "DETACHED" | "CANCELLED" | null,
): string | null {
  if (exception === "DETACHED") return "Modificada individualmente";
  if (exception === "CANCELLED") return "Cancelada";
  return null;
}

export function capitalizeEs(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
