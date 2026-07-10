/** Spanish owner-facing copy for Analytics briefing (API labels are English). */

export function translateAttentionLabel(label: string): string {
  return label
    .replace(/(\d+) overdue payment(s)?/gi, (_, n) =>
      n === "1" ? "1 pago vencido" : `${n} pagos vencidos`,
    )
    .replace(/(\d+) failed payment(s)?/gi, (_, n) =>
      n === "1" ? "1 pago fallido" : `${n} pagos fallidos`,
    )
    .replace(/(\d+) membership(s)? expiring/gi, (_, n) =>
      n === "1" ? "1 membresía por vencer" : `${n} membresías por vencer`,
    )
    .replace(/(\d+) waiver(s)? pending/gi, (_, n) =>
      n === "1" ? "1 carta responsiva pendiente" : `${n} cartas responsivas pendientes`,
    )
    .replace(/Revenue (\d+)% behind vs last month/gi, "Ingresos $1% por debajo vs mes pasado");
}

export function translateAttentionAction(itemId: string, action: string): string {
  if (itemId === "expiring") return "Renovar";
  if (itemId === "waivers" || itemId === "overdue" || itemId === "failed" || itemId === "revenue-behind") {
    return "Revisar";
  }
  if (action === "Review") return "Revisar";
  if (action === "Renew") return "Renovar";
  if (action === "Collect") return "Cobrar";
  return action;
}

export function translateChangeLabel(label: string): string {
  return label
    .replace(/\+(\d+) new membership(s)?/gi, (_, n) =>
      n === "1" ? "+1 nueva membresía" : `+${n} nuevas membresías`,
    )
    .replace(/\+(\d+) check-in(s)?/gi, (_, n) =>
      n === "1" ? "+1 check-in" : `+${n} check-ins`,
    )
    .replace(/\+(\d+) payment(s)? collected/gi, (_, n) =>
      n === "1" ? "+1 pago cobrado" : `+${n} pagos cobrados`,
    )
    .replace(/Revenue ([+-]?\d+(?:\.\d+)?)% vs yesterday \(same time\)/gi, "Ingresos $1% vs ayer (misma hora)")
    .replace(/Revenue ([+-]?\d+(?:\.\d+)?)% vs yesterday/gi, "Ingresos $1% vs ayer");
}

export function translateDelight(text: string | null | undefined): string | null {
  if (!text) return null;
  const map: Record<string, string> = {
    "Strong month.": "Mes fuerte.",
    "Revenue is ahead of last month.": "Los ingresos van adelante del mes pasado.",
    "Everything looks healthy.": "Todo se ve saludable.",
    "Membership activity is strong.": "La actividad de membresías es fuerte.",
  };
  return map[text] ?? null;
}

export const SUBSCRIPTION_STATUS_ES: Record<string, string> = {
  ACTIVE: "Activa",
  TRIALING: "Prueba",
  PAST_DUE: "Vencida",
  PAUSED: "Pausada",
  CANCELED: "Cancelada",
};

export function translateSubscriptionStatus(status: string): string {
  return SUBSCRIPTION_STATUS_ES[status] ?? status.replaceAll("_", " ");
}
