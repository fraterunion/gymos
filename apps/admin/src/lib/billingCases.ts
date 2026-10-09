import type { BillingCase, BillingCaseListResponse, BillingCaseSeverity, BillingCaseStatus, BillingReconciliationRun } from "./api/billingReconciliation";

/** Pure presentation helpers for billing reconciliation cases (no React, no runtime `@/` imports). */

export type Tone = "critical" | "warning" | "info" | "neutral" | "ok";

export function severityTone(severity: BillingCaseSeverity): Tone {
  switch (severity) {
    case "CRITICAL": return "critical";
    case "HIGH": return "warning";
    case "MEDIUM": return "info";
    case "LOW": return "neutral";
  }
}

export function toneClasses(tone: Tone): string {
  switch (tone) {
    case "critical": return "bg-red-100 text-red-800";
    case "warning": return "bg-amber-100 text-amber-900";
    case "info": return "bg-sky-100 text-sky-800";
    case "ok": return "bg-emerald-100 text-emerald-800";
    default: return "bg-zinc-100 text-zinc-700";
  }
}

export function statusTone(status: BillingCaseStatus): Tone {
  switch (status) {
    case "OPEN": return "warning";
    case "ACKNOWLEDGED": return "info";
    case "RESOLVED": return "ok";
    case "DISMISSED": return "neutral";
  }
}

export type CaseFilterPreset = "active" | "open" | "acknowledged" | "resolved" | "dismissed" | "all";

export const FILTER_PRESETS: { id: CaseFilterPreset; label: string; status: BillingCaseStatus[] | undefined }[] = [
  { id: "active", label: "Pendientes", status: ["OPEN", "ACKNOWLEDGED"] },
  { id: "open", label: "Sin revisar", status: ["OPEN"] },
  { id: "acknowledged", label: "En revisión", status: ["ACKNOWLEDGED"] },
  { id: "resolved", label: "Resueltos", status: ["RESOLVED"] },
  { id: "dismissed", label: "Descartados", status: ["DISMISSED"] },
  { id: "all", label: "Todos", status: ["OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"] },
];

/** Counts per severity among unresolved cases, for the header summary. */
export function activeSeverityCounts(counts: BillingCaseListResponse["counts"]): Record<BillingCaseSeverity, number> {
  const out: Record<BillingCaseSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const c of counts) {
    if (c.status === "OPEN" || c.status === "ACKNOWLEDGED") out[c.severity] += c.count;
  }
  return out;
}

export function headerSummary(counts: Record<BillingCaseSeverity, number>): string {
  const total = counts.CRITICAL + counts.HIGH + counts.MEDIUM + counts.LOW;
  if (total === 0) return "Sin casos pendientes.";
  const parts = [
    counts.CRITICAL ? `${counts.CRITICAL} crítico${counts.CRITICAL === 1 ? "" : "s"}` : null,
    counts.HIGH ? `${counts.HIGH} alto${counts.HIGH === 1 ? "" : "s"}` : null,
    counts.MEDIUM ? `${counts.MEDIUM} medio${counts.MEDIUM === 1 ? "" : "s"}` : null,
    counts.LOW ? `${counts.LOW} bajo${counts.LOW === 1 ? "" : "s"}` : null,
  ].filter((p): p is string => p !== null);
  return `${total} caso${total === 1 ? "" : "s"} pendiente${total === 1 ? "" : "s"}: ${parts.join(", ")}.`;
}

/** Which operator actions make sense for a case in its current status. */
export function availableActions(status: BillingCaseStatus): { id: "acknowledge" | "resolve" | "dismiss" | "reopen"; label: string; requiresNote: boolean }[] {
  switch (status) {
    case "OPEN":
      return [
        { id: "acknowledge", label: "Marcar como revisado", requiresNote: false },
        { id: "resolve", label: "Marcar como resuelto", requiresNote: true },
        { id: "dismiss", label: "Descartar", requiresNote: true },
      ];
    case "ACKNOWLEDGED":
      return [
        { id: "resolve", label: "Marcar como resuelto", requiresNote: true },
        { id: "dismiss", label: "Descartar", requiresNote: true },
      ];
    case "RESOLVED":
    case "DISMISSED":
      return [{ id: "reopen", label: "Reabrir", requiresNote: false }];
  }
}

const dateFmt = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}

/** "Última revisión automática: hace 3 h · completa" */
export function runSummaryLine(run: BillingReconciliationRun | null, now: Date = new Date()): string {
  if (!run) return "Aún no se ha ejecutado una revisión automática.";
  const ref = run.finishedAt ?? run.startedAt;
  const ms = now.getTime() - new Date(ref).getTime();
  const ago = ms < 3_600_000 ? `hace ${Math.max(1, Math.round(ms / 60_000))} min` : ms < 86_400_000 ? `hace ${Math.round(ms / 3_600_000)} h` : `hace ${Math.round(ms / 86_400_000)} d`;
  const state = run.status === "RUNNING" ? "en curso" : run.status === "COMPLETED" ? "completa" : run.status === "PARTIAL" ? "parcial (algún detector no terminó)" : "falló";
  return `Última revisión ${run.trigger === "MANUAL" ? "manual" : "automática"}: ${ago} · ${state}.`;
}

/** Evidence rows worth showing, in a stable, operator-friendly order. */
export function evidenceRows(c: Pick<BillingCase, "evidence">): { label: string; value: string }[] {
  const labels: Record<string, string> = {
    amountCents: "Monto",
    amountRefundedCents: "Reembolsado",
    amountRemainingCents: "Pendiente de cobro",
    currency: "Moneda",
    stripeInvoiceId: "Factura",
    billingReason: "Motivo de la factura",
    servicePeriodStart: "Periodo pagado desde",
    servicePeriodEnd: "Periodo pagado hasta",
    paidAt: "Pagado el",
    entitlementGranted: "Vigencia otorgada",
    whyNotGranted: "Por qué no se otorgó",
    stripeStatus: "Estado en Stripe",
    localStatus: "Estado en GymOS",
    localEndReason: "Motivo de baja en GymOS",
    localPeriodEnd: "Fin de vigencia en GymOS",
    stripeCurrentPeriodEnd: "Fin de periodo en Stripe",
    stripeCanceledAt: "Cancelada en Stripe el",
    stripeCancellationReason: "Motivo en Stripe",
    expectedEndReason: "Motivo esperado",
    currentEndReason: "Motivo registrado",
    attempts: "Intentos de cobro",
    attemptCount: "Intentos de cobro",
    nextPaymentAttempt: "Próximo intento",
    lastAttemptAt: "Último intento",
    eventType: "Tipo de evento",
    lastError: "Error",
    scenario: "Escenario",
  };
  const skip = new Set(["paymentId", "key"]);
  const rows: { label: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(c.evidence ?? {})) {
    if (skip.has(key) || raw === null || raw === undefined) continue;
    const label = labels[key] ?? key;
    let value: string;
    if (key.endsWith("Cents") && typeof raw === "number") {
      const currency = typeof c.evidence["currency"] === "string" ? (c.evidence["currency"] as string).toUpperCase() : "MXN";
      value = new Intl.NumberFormat("es-MX", { style: "currency", currency }).format(raw / 100);
    } else if (typeof raw === "boolean") {
      value = raw ? "Sí" : "No";
    } else if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T/.test(raw)) {
      value = when(raw);
    } else if (typeof raw === "object") {
      value = JSON.stringify(raw);
    } else {
      value = String(raw);
    }
    rows.push({ label, value });
  }
  const order = Object.keys(labels);
  return rows.sort((a, b) => {
    const ia = order.indexOf(Object.keys(labels).find((k) => labels[k] === a.label) ?? "");
    const ib = order.indexOf(Object.keys(labels).find((k) => labels[k] === b.label) ?? "");
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}
