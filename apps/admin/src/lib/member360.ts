import type { MemberProfile, MemberRole, PaymentSource, PrimaryLifecycleStatus } from "@/lib/api/members";

export type Member360Action = { id: "membership" | "billing" | "notes"; label: string; emphasis: "primary" | "secondary" };

export function member360Actions(
  studioRole: MemberRole | string | null,
  membership: { primaryStatus: PrimaryLifecycleStatus; source: Exclude<PaymentSource, "NONE">; cancelAtPeriodEnd: boolean } | null,
): Member360Action[] {
  const canManage = studioRole === "OWNER" || studioRole === "ADMIN";
  const canReadOperations = canManage || studioRole === "STAFF" || studioRole === "FRONT_DESK";
  if (!canReadOperations) return [];
  if (!membership) return canManage ? [{ id: "membership", label: "Asignar membresía", emphasis: "primary" }] : [];
  const actions: Member360Action[] = [];
  if (canManage) {
    actions.push({
      id: "membership",
      label: membership.primaryStatus === "EXPIRED" ? "Renovar membresía" : membership.cancelAtPeriodEnd && membership.source === "STRIPE" ? "Revisar renovación" : "Gestionar membresía",
      emphasis: "primary",
    });
  }
  actions.push({ id: "billing", label: "Ver facturación", emphasis: canManage ? "secondary" : "primary" });
  actions.push({ id: "notes", label: studioRole === "FRONT_DESK" ? "Ver notas" : "Notas y CRM", emphasis: "secondary" });
  return actions;
}

export function billingOperationalState(profile: Pick<MemberProfile, "currentMembership" | "operations">): string {
  const membership = profile.currentMembership;
  if (!membership) return "No aplica";
  if (membership.lifecycleStatus === "PAST_DUE") return "Pago pendiente";
  return "Al corriente";
}

export function renewalBehavior(membership: Pick<NonNullable<MemberProfile["currentMembership"]>, "source" | "cancelAtPeriodEnd" | "primaryStatus">) {
  if (membership.source !== "STRIPE") {
    return membership.primaryStatus === "EXPIRED" ? "Requiere renovación manual" : "Manual";
  }
  return membership.cancelAtPeriodEnd ? "No renovará" : "Automática";
}

export function paymentSourceLabel(source: NonNullable<MemberProfile["currentMembership"]>["source"] | null | undefined) {
  if (source === "CASH") return "Efectivo";
  if (source === "STRIPE") return "Stripe";
  if (source === "MANUAL") return "Manual";
  return "—";
}

export function usagePresentation(profile: Pick<MemberProfile, "currentMembership" | "engagement">) {
  const membership = profile.currentMembership;
  if (!membership) return { label: "Visitas · 30 días", value: String(profile.engagement.visitsLast30Days), detail: "historial reciente" };
  if (membership.plan.classCredits === null) {
    return { label: "Visitas este periodo", value: String(profile.engagement.visitsCurrentPeriod), detail: "membresía ilimitada" };
  }
  return {
    label: "Créditos del periodo",
    value: `${membership.creditsUsed ?? 0} / ${membership.plan.classCredits}`,
    detail: `${membership.creditsRemaining ?? 0} restantes`,
  };
}

export function allowedClassPresentation(membership: NonNullable<MemberProfile["currentMembership"]>): string[] {
  if (!membership.isEntitled) return ["Sin acceso vigente"];
  if (membership.plan.allClassesAccess) return ["Todas las clases"];
  if (membership.plan.allowedTemplates.length === 0) return ["Sin clases configuradas"];
  return membership.plan.allowedTemplates.map((template) => {
    const hours = template.isOpenGymSlot && template.accessWindowStart && template.accessWindowEnd
      ? ` · ${template.accessWindowStart}–${template.accessWindowEnd}`
      : "";
    return `${template.name}${hours}`;
  });
}

export function cyclePayment(subscription: { payments: Array<{ stripeInvoiceId: string | null; status: string; amountCents: number; currency: string; paymentMethod: string }> }, stripeInvoiceId: string | null) {
  if (!stripeInvoiceId) return null;
  return subscription.payments.find((payment) => payment.stripeInvoiceId === stripeInvoiceId && payment.status === "SUCCEEDED") ?? null;
}
