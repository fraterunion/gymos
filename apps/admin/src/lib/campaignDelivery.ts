/**
 * How a campaign's delivery state reads in the admin, and which single action is allowed.
 * The API reports deliveryState only for SENDING campaigns:
 *   ACTIVE — being delivered; PAUSED — delivery is off on the server (nothing leaves);
 *   STALE — queued too long ago, never resumed automatically: needs an explicit "Reanudar".
 */

export type CampaignDeliveryState = "ACTIVE" | "PAUSED" | "STALE";

export type CampaignStateInput = {
  status: string;
  deliveryState?: CampaignDeliveryState | null;
  pendingCount?: number;
  failedCount: number;
  sentCount: number;
  recipientCount: number;
};

export type CampaignTone = "neutral" | "progress" | "warning" | "success" | "danger";

export function campaignStateLabel(c: CampaignStateInput): { label: string; tone: CampaignTone } {
  const pending = c.pendingCount ?? Math.max(0, c.recipientCount - c.sentCount - c.failedCount);
  switch (c.status) {
    case "DRAFT":
      return { label: "Borrador · no enviada", tone: "neutral" };
    case "SENDING":
      if (c.deliveryState === "PAUSED") return { label: `En pausa · envíos desactivados · ${pending} pendientes`, tone: "warning" };
      if (c.deliveryState === "STALE") return { label: `Detenida · requiere reanudar · ${pending} pendientes`, tone: "warning" };
      return { label: `Enviando · ${c.sentCount}/${c.recipientCount} enviados`, tone: "progress" };
    case "COMPLETED":
      return { label: `Enviada · ${c.sentCount}/${c.recipientCount}`, tone: "success" };
    case "PARTIAL":
      return { label: `Parcial · ${c.failedCount} fallos`, tone: "danger" };
    case "FAILED":
      return { label: "Fallida · no se envió", tone: "danger" };
    default:
      return { label: c.status, tone: "neutral" };
  }
}

export type CampaignAction = "CONFIRM" | "RESUME" | "RETRY_FAILED";

/** Nothing can be queued or resumed while delivery is paused on the server. */
export function campaignAction(c: CampaignStateInput, deliveryActive: boolean): CampaignAction | null {
  if (!deliveryActive) return null;
  if (c.status === "DRAFT") return "CONFIRM";
  if (c.status === "SENDING" && c.deliveryState === "STALE") return "RESUME";
  if ((c.status === "PARTIAL" || c.status === "FAILED") && c.failedCount > 0) return "RETRY_FAILED";
  return null;
}

export const CAMPAIGN_ACTION_LABEL: Record<CampaignAction, string> = {
  CONFIRM: "Confirmar envío",
  RESUME: "Reanudar envío",
  RETRY_FAILED: "Reintentar fallidos",
};

export function formatSender(name: string | null, address: string | null): string {
  if (!address) return "—";
  return name ? `${name} <${address}>` : address;
}
