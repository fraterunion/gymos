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
  if (!membership) return "Sin membresía";
  if (membership.lifecycleStatus === "PAST_DUE") return "Pago pendiente";
  if (membership.primaryStatus === "EXPIRED") return "Vencida";
  if (membership.source !== "STRIPE") return "Renovación manual";
  if (membership.cancelAtPeriodEnd) return "No renovará";
  return "Al corriente";
}

export function usagePresentation(profile: Pick<MemberProfile, "currentMembership" | "engagement">) {
  const membership = profile.currentMembership;
  if (!membership) return { value: String(profile.engagement.visitsLast30Days), detail: "visitas en 30 días" };
  if (membership.plan.classCredits === null) {
    return { value: String(profile.engagement.visitsCurrentPeriod), detail: "visitas este periodo" };
  }
  return {
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
