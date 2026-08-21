import type {
  RetentionHealth,
  RetentionMovement,
  RetentionSuggestedAction,
} from "@/lib/api/retention-analytics";

export const RETENTION_HEALTH_LABELS: Record<RetentionHealth, string> = {
  HEALTHY: "Saludable",
  OBSERVATION: "En observación",
  AT_RISK: "En riesgo",
  INACTIVE: "Sin actividad",
  LAPSED: "Membresía finalizada",
};

export const RETENTION_MOVEMENT_LABELS: Record<RetentionMovement, string> = {
  MEJORANDO: "Mejorando",
  ESTABLE: "Estable",
  BAJANDO: "Bajando",
  EN_RIESGO: "En riesgo",
  RECUPERADO: "Recuperado",
  SIN_ACTIVIDAD: "Sin actividad",
  MEMBRESIA_FINALIZADA: "Membresía finalizada",
  SIN_BASELINE: "Sin historial suficiente",
};

export const RETENTION_ACTION_LABELS: Record<RetentionSuggestedAction, string> = {
  CONTACTAR: "Contactar",
  DAR_SEGUIMIENTO: "Dar seguimiento",
  REVISAR_MEMBRESIA: "Revisar membresía",
  FELICITAR_REGRESO: "Felicitar regreso",
  SIN_ACCION: "Sin acción",
};

export const RETENTION_HEALTH_CLASS: Record<RetentionHealth, string> = {
  HEALTHY: "bg-emerald-50 text-emerald-800",
  OBSERVATION: "bg-amber-50 text-amber-800",
  AT_RISK: "bg-orange-50 text-orange-800",
  INACTIVE: "bg-zinc-100 text-zinc-700",
  LAPSED: "bg-zinc-200 text-zinc-600",
};

export const FREQUENCY_KPI_LABEL = "Visitas / miembro que asistió";
export const FREQUENCY_KPI_HELP =
  "Promedio de visitas en los últimos 30 días entre miembros activos que registraron al menos una asistencia.";

export const COHORT_SECTION_TITLE = "Retención por asistencia";
export const COHORT_SECTION_HELP =
  "Porcentaje de miembros de cada cohorte que registró al menos una asistencia en cada mes desde su alta.";

export const CLASS_STICKINESS_SECTION_TITLE = "Regreso después de clase";
export const CLASS_STICKINESS_SECTION_HELP =
  "Porcentaje de miembros que asistió nuevamente a cualquier clase después de haber asistido a esta clase.";

export function formatDeltaPct(pct: number | null): string {
  if (pct == null) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct}%`;
}

export function formatJoinedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("es-MX", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

export function formatCohortCell(cell: {
  retained: number;
  cohortSize: number;
  ratePct: number | null;
  suppressed: boolean;
  limitedHistoryCoverage?: boolean;
}): string {
  if (cell.suppressed) return "—";
  const base = `${cell.retained}/${cell.cohortSize}${
    cell.ratePct != null ? ` · ${cell.ratePct}%` : ""
  }`;
  return cell.limitedHistoryCoverage ? `${base}*` : base;
}
