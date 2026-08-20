import type { LifecycleStatus, MemberSubscriptionSummary, PrimaryLifecycleStatus } from "@/lib/api/members";

const STUDIO_TIME_ZONE = "America/Mexico_City";

export const PRIMARY_STATUS_LABELS: Record<PrimaryLifecycleStatus, string> = {
  ACTIVE: "Activa",
  TRIALING: "Prueba",
  EXPIRED: "Vencida",
  PAST_DUE: "Pago pendiente",
  PAUSED: "Pausada",
  CANCELED: "Cancelada",
  SCHEDULED: "Programada",
};

export const PRIMARY_STATUS_COLORS: Record<PrimaryLifecycleStatus, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
  TRIALING: "bg-sky-50 text-sky-700 ring-sky-600/15",
  EXPIRED: "bg-rose-50 text-rose-700 ring-rose-600/15",
  PAST_DUE: "bg-rose-50 text-rose-700 ring-rose-600/15",
  PAUSED: "bg-amber-50 text-amber-700 ring-amber-600/15",
  CANCELED: "bg-zinc-100 text-zinc-600 ring-zinc-500/15",
  SCHEDULED: "bg-blue-50 text-blue-700 ring-blue-600/15",
};

export function primaryStatus(status: LifecycleStatus): PrimaryLifecycleStatus {
  return status === "ENDING" ? "ACTIVE" : status;
}

export function studioDate(iso: string | null | undefined, withYear = false) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: STUDIO_TIME_ZONE,
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(iso)).replace(".", "");
}

type RenewalMembership = Pick<MemberSubscriptionSummary, "lifecycleStatus" | "source" | "cancelAtPeriodEnd" | "currentPeriodStart" | "currentPeriodEnd" | "effectiveEnd"> & { entitlementDays?: number | null };

export const PAYMENT_SOURCE_PRESENTATION = {
  STRIPE: { label: "Stripe", className: "bg-violet-50 text-violet-700 ring-violet-600/15" },
  CASH: { label: "Efectivo", className: "bg-emerald-50 text-emerald-700 ring-emerald-600/15" },
  MANUAL: { label: "Manual", className: "bg-sky-50 text-sky-700 ring-sky-600/15" },
} as const;

export function renewalPresentation(subscription: RenewalMembership, now = new Date()) {
  const end = subscription.effectiveEnd;
  if (subscription.lifecycleStatus === "SCHEDULED") {
    return { title: `Inicia ${studioDate(subscription.currentPeriodStart)}`, detail: null };
  }
  if (subscription.lifecycleStatus === "PAST_DUE") {
    return { title: "Cobro pendiente", detail: end ? `Vigencia ${studioDate(end)}` : null };
  }
  if (subscription.lifecycleStatus === "EXPIRED") {
    const days = end ? Math.max(0, Math.floor((now.getTime() - new Date(end).getTime()) / 86_400_000)) : null;
    return { title: `Venció ${studioDate(end)}`, detail: days === null ? null : days === 0 ? "Hoy" : `hace ${days} ${days === 1 ? "día" : "días"}` };
  }
  if (subscription.source === "STRIPE" && !subscription.cancelAtPeriodEnd) {
    return {
      title: `Renueva ${studioDate(subscription.currentPeriodEnd ?? end)}`,
      detail: subscription.entitlementDays
        ? `Ciclo de ${subscription.entitlementDays} días · vigencia hasta ${studioDate(end)}`
        : "Automática",
    };
  }
  const detail = subscription.source === "STRIPE" && subscription.cancelAtPeriodEnd
    ? "No renovará"
    : subscription.entitlementDays
      ? `Renovación manual · ciclo de ${subscription.entitlementDays} días`
      : "Renovación manual";
  return { title: `Vence ${studioDate(end)}`, detail };
}

export function visitPresentation(iso: string | null | undefined, now = new Date()) {
  if (!iso) return { title: "Nunca", detail: null };
  const days = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
  if (days === 0) return { title: "Hoy", detail: null };
  if (days === 1) return { title: "Ayer", detail: null };
  return { title: studioDate(iso), detail: `hace ${days} días` };
}

export function nextClassPresentation(iso: string | null | undefined, now = new Date()) {
  if (!iso) return "—";
  const date = new Date(iso);
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const delta = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  const day = delta === 0 ? "Hoy" : delta === 1 ? "Mañana" : studioDate(iso);
  const time = new Intl.DateTimeFormat("es-MX", { timeZone: STUDIO_TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(date);
  return `${day} · ${time}`;
}
