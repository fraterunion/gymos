export type PlanSummaryTemplate = {
  name: string;
  active: boolean;
  isOpenGymSlot: boolean;
  accessWindowStart: string | null;
  accessWindowEnd: string | null;
};

export type PlanForSummary = {
  active: boolean;
  entitlementDays: number | null;
  classCredits: number | null;
  allowedCategories: string[];
  activeSubscriberCount: number;
  classAccess: { allClasses: boolean; templates: PlanSummaryTemplate[] };
};

/** "Cada 45 días" for fixed-duration plans, or null when the plan follows the normal
 *  recurring billingInterval (the price line should append the interval instead). */
export function planCycleLabel(plan: Pick<PlanForSummary, "entitlementDays">): string | null {
  if (plan.entitlementDays === null) return null;
  return `Cada ${plan.entitlementDays} días`;
}

export function planUsageLabel(plan: Pick<PlanForSummary, "classCredits">): string {
  if (plan.classCredits === null) return "Ilimitado";
  return plan.classCredits === 1 ? "1 crédito" : `${plan.classCredits} créditos`;
}

export type PlanAccessSummary = {
  label: string;
  regularCount: number;
  hasOpenGym: boolean;
};

/** Derives the human access summary from the same canonical fields the booking engine
 *  reads (classAccess.allClasses / template list with isOpenGymSlot) — never re-derives
 *  Open Gym membership from a template name. */
export function planAccessSummary(plan: Pick<PlanForSummary, "classAccess">): PlanAccessSummary {
  if (plan.classAccess.allClasses) {
    return { label: "Todas las clases", regularCount: 0, hasOpenGym: false };
  }
  const activeTemplates = plan.classAccess.templates.filter((t) => t.active);
  const openGymTemplates = activeTemplates.filter((t) => t.isOpenGymSlot);
  const regularTemplates = activeTemplates.filter((t) => !t.isOpenGymSlot);
  const hasOpenGym = openGymTemplates.length > 0;
  const regularCount = regularTemplates.length;

  if (regularCount === 0 && !hasOpenGym) {
    return { label: "Sin clases permitidas", regularCount, hasOpenGym };
  }
  if (regularCount === 0 && hasOpenGym) {
    const og = openGymTemplates[0];
    const window = og.accessWindowStart && og.accessWindowEnd
      ? ` · ${og.accessWindowStart}–${og.accessWindowEnd}`
      : "";
    return { label: `Acceso Open Gym${window}`, regularCount, hasOpenGym };
  }
  if (regularCount === 1 && !hasOpenGym) {
    return { label: `Solo ${regularTemplates[0].name}`, regularCount, hasOpenGym };
  }
  if (hasOpenGym) {
    return {
      label: `${regularCount} ${regularCount === 1 ? "clase" : "clases"} + Open Gym`,
      regularCount,
      hasOpenGym,
    };
  }
  return {
    label: `${regularCount} ${regularCount === 1 ? "clase permitida" : "clases permitidas"}`,
    regularCount,
    hasOpenGym,
  };
}

/** Deterministic configuration warnings, derived only from data already on the plan —
 *  never speculative, never auto-corrected. */
export function planWarnings(plan: PlanForSummary): string[] {
  const warnings: string[] = [];

  if (plan.classAccess.allClasses) {
    warnings.push(
      "Acceso a todas las clases activas — incluye Booty Lab y Open Gym.",
    );
  }

  if (plan.entitlementDays !== null && plan.entitlementDays <= 0) {
    warnings.push("Duración fija inválida (≤ 0 días).");
  }

  if (plan.classCredits !== null && plan.classCredits <= 0) {
    warnings.push("0 créditos configurados — nadie podrá reservar con este plan.");
  }

  if (
    !plan.classAccess.allClasses &&
    plan.classAccess.templates.filter((t) => t.active).length === 0 &&
    plan.allowedCategories.length === 0
  ) {
    warnings.push("Plan restringido sin ninguna clase permitida — nadie puede reservar.");
  }

  if (!plan.active && plan.activeSubscriberCount > 0) {
    const n = plan.activeSubscriberCount;
    warnings.push(
      `Plan inactivo con ${n} suscripci${n === 1 ? "ón" : "ones"} activa${n === 1 ? "" : "s"}.`,
    );
  }

  return warnings;
}

export type PlanHealth = {
  label: "Saludable" | "Requiere atención";
  tone: "healthy" | "warning";
  issues: string[];
};

export function planHealth(
  plan: PlanForSummary,
  integrityStatus?: string,
): PlanHealth {
  const issues = planWarnings(plan);
  if (integrityStatus && integrityStatus !== "healthy") {
    issues.push(
      integrityStatus === "no_stripe_price"
        ? "Sin Price de Stripe configurado."
        : "Configuración de GymOS y Stripe desalineada.",
    );
  }
  return issues.length === 0
    ? { label: "Saludable", tone: "healthy", issues }
    : { label: "Requiere atención", tone: "warning", issues };
}

export type OperationalOverview = {
  activePlans: number;
  activeMembers: number;
  endingSoon: number;
  requiringAttention: number;
};

export function operationalOverview(input: {
  totalActivePlans: number;
  totalActiveSubscribers: number;
  byStatus: Record<string, number>;
  unhealthyPlanCount: number;
}): OperationalOverview {
  const count = (status: string) => input.byStatus[status] ?? 0;
  return {
    activePlans: input.totalActivePlans,
    activeMembers: input.totalActiveSubscribers,
    endingSoon: count("ENDING"),
    requiringAttention:
      count("PAST_DUE") + count("PAUSED") + count("EXPIRED") + input.unhealthyPlanCount,
  };
}

export type SubscriptionForActions = {
  lifecycleStatus: string;
  source: "STRIPE" | "CASH" | "MANUAL";
  cancelAtPeriodEnd: boolean;
  isEntitled: boolean;
};

export type SubscriptionAction =
  | "view_member"
  | "change_plan"
  | "renew"
  | "pause"
  | "resume"
  | "cancel_at_period_end"
  | "reactivate_renewal"
  | "record_cash_payment";

export function subscriptionActions(sub: SubscriptionForActions): SubscriptionAction[] {
  const actions: SubscriptionAction[] = ["view_member"];
  if (sub.lifecycleStatus === "EXPIRED" && sub.source !== "STRIPE") {
    return [...actions, "renew", "change_plan", "record_cash_payment"];
  }
  if (sub.lifecycleStatus === "PAUSED") {
    return sub.source === "STRIPE" ? actions : [...actions, "resume"];
  }
  if (!sub.isEntitled) return actions;
  actions.push("change_plan");
  if (sub.source === "STRIPE") {
    actions.push(sub.cancelAtPeriodEnd ? "reactivate_renewal" : "cancel_at_period_end");
  } else {
    actions.push("pause");
  }
  return actions;
}
