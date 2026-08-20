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
  openGymWindow: string | null;
};

/** Derives the human access summary from the same canonical fields the booking engine
 *  reads (classAccess.allClasses / template list with isOpenGymSlot) — never re-derives
 *  Open Gym membership from a template name. */
export function planAccessSummary(plan: Pick<PlanForSummary, "classAccess">): PlanAccessSummary {
  if (plan.classAccess.allClasses) {
    return { label: "Todas las clases", regularCount: 0, hasOpenGym: false, openGymWindow: null };
  }
  const activeTemplates = plan.classAccess.templates.filter((t) => t.active);
  const openGymTemplates = activeTemplates.filter((t) => t.isOpenGymSlot);
  const regularTemplates = activeTemplates.filter((t) => !t.isOpenGymSlot);
  const hasOpenGym = openGymTemplates.length > 0;
  const regularCount = regularTemplates.length;
  const og = openGymTemplates[0];
  const openGymWindow =
    og?.accessWindowStart && og.accessWindowEnd
      ? `${og.accessWindowStart}–${og.accessWindowEnd}`
      : null;

  if (regularCount === 0 && !hasOpenGym) {
    return { label: "Sin clases permitidas", regularCount, hasOpenGym, openGymWindow };
  }
  if (regularCount === 0 && hasOpenGym) {
    return { label: "Solo Open Gym", regularCount, hasOpenGym, openGymWindow };
  }
  if (regularCount === 1 && !hasOpenGym) {
    return { label: `Solo ${regularTemplates[0].name}`, regularCount, hasOpenGym, openGymWindow };
  }
  if (hasOpenGym) {
    return {
      label: `${regularCount} ${regularCount === 1 ? "clase" : "clases"} + Open Gym`,
      regularCount,
      hasOpenGym,
      openGymWindow,
    };
  }
  return {
    label: `${regularCount} ${regularCount === 1 ? "clase permitida" : "clases permitidas"}`,
    regularCount,
    hasOpenGym,
    openGymWindow,
  };
}

/** Compact card copy: usage line + access line (+ optional schedule for Open Gym-only). */
export function planCardLines(plan: Pick<PlanForSummary, "classCredits" | "classAccess">): {
  usageLine: string;
  accessLine: string;
  scheduleLine: string | null;
} {
  const access = planAccessSummary(plan);
  const usageLine = planUsageLabel(plan);

  if (access.label === "Solo Open Gym") {
    return {
      usageLine,
      accessLine: "Solo Open Gym",
      scheduleLine: access.openGymWindow ? `Horario ${access.openGymWindow}` : null,
    };
  }

  return {
    usageLine,
    accessLine: access.label,
    scheduleLine: null,
  };
}

/** Staff-friendly translation of Stripe integrity statuses — never raw enum labels. */
export function integrityIssueLabel(status: string): string {
  switch (status) {
    case "price_mismatch":
      return "GymOS y Stripe tienen precios distintos";
    case "currency_mismatch":
      return "Moneda distinta entre GymOS y Stripe";
    case "interval_mismatch":
      return "Ciclo de GymOS y Stripe desalineado";
    case "no_stripe_price":
      return "Sin Price de Stripe configurado";
    case "inactive_stripe_price":
      return "Price de Stripe inactivo";
    case "fetch_error":
      return "No se pudo verificar Stripe";
    default:
      return "Configuración de GymOS y Stripe desalineada";
  }
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
  primaryIssue: string | null;
  extraIssueCount: number;
};

export function planHealth(
  plan: PlanForSummary,
  integrityStatus?: string,
): PlanHealth {
  const issues = planWarnings(plan);
  if (integrityStatus && integrityStatus !== "healthy") {
    issues.push(integrityIssueLabel(integrityStatus));
  }
  const primaryIssue = issues[0] ?? null;
  return issues.length === 0
    ? { label: "Saludable", tone: "healthy", issues, primaryIssue: null, extraIssueCount: 0 }
    : {
        label: "Requiere atención",
        tone: "warning",
        issues,
        primaryIssue,
        extraIssueCount: Math.max(0, issues.length - 1),
      };
}

export type OperationalOverview = {
  activePlans: number;
  activeMembers: number;
  expiringWithin7Days: number;
  requiringAttention: number;
};

export function operationalOverview(input: {
  totalActivePlans: number;
  totalActiveSubscribers: number;
  expiringWithin7Days: number;
  requiringAttentionSubscriptions: number;
  unhealthyPlanCount: number;
}): OperationalOverview {
  return {
    activePlans: input.totalActivePlans,
    activeMembers: input.totalActiveSubscribers,
    expiringWithin7Days: input.expiringWithin7Days,
    requiringAttention:
      input.requiringAttentionSubscriptions + input.unhealthyPlanCount,
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

const SUBSCRIPTION_ACTION_LABELS: Record<SubscriptionAction, string> = {
  view_member: "Ver miembro",
  change_plan: "Cambiar plan",
  renew: "Renovar",
  pause: "Pausar",
  resume: "Reanudar",
  cancel_at_period_end: "Cancelar al final del periodo",
  reactivate_renewal: "Reactivar renovación",
  record_cash_payment: "Registrar pago en efectivo",
};

export function subscriptionActionLabel(action: SubscriptionAction): string {
  return SUBSCRIPTION_ACTION_LABELS[action];
}

export function subscriptionOperationalStatusLabel(lifecycleStatus: string): string {
  switch (lifecycleStatus) {
    case "ACTIVE":
      return "Activa";
    case "TRIALING":
      return "Prueba";
    case "ENDING":
      return "Por vencer";
    case "PAST_DUE":
      return "Pago pendiente";
    case "PAUSED":
      return "Pausada";
    case "EXPIRED":
      return "Vencida";
    case "SCHEDULED":
      return "Programada";
    case "CANCELED":
      return "Cancelada";
    default:
      return lifecycleStatus;
  }
}

export function subscriptionPaymentSourceLabel(
  source: SubscriptionForActions["source"],
): string {
  switch (source) {
    case "STRIPE":
      return "Stripe";
    case "CASH":
      return "Efectivo";
    case "MANUAL":
      return "Manual";
    default:
      return source;
  }
}

export function subscriptionValidityLines(input: {
  lifecycleStatus: string;
  source: SubscriptionForActions["source"];
  cancelAtPeriodEnd: boolean;
  effectiveEnd: string | null;
  entitlementDays: number | null;
  billingInterval: string;
}): { primary: string; secondary: string | null } {
  const end = input.effectiveEnd
    ? new Date(input.effectiveEnd).toLocaleDateString("es-MX", { day: "numeric", month: "short" })
    : null;

  if (input.lifecycleStatus === "EXPIRED" && end) {
    return { primary: `Venció ${end}`, secondary: "Renovación manual" };
  }

  if (input.cancelAtPeriodEnd && end) {
    return { primary: `Vence ${end}`, secondary: "No renovará automáticamente" };
  }

  if (input.source === "STRIPE" && end) {
    return { primary: `Renueva ${end}`, secondary: "Automática" };
  }

  if (end) {
    const cycle =
      input.entitlementDays != null
        ? `Cada ${input.entitlementDays} días`
        : input.billingInterval === "MONTHLY"
          ? "Mensual"
          : input.billingInterval === "YEARLY"
            ? "Anual"
            : "Semanal";
    return { primary: `Vence ${end}`, secondary: cycle };
  }

  return { primary: "—", secondary: null };
}

export function dayPassHealthLabel(allowedCount: number, totalCount: number): PlanHealth {
  if (totalCount === 0 || allowedCount === 0) {
    return {
      label: "Requiere atención",
      tone: "warning",
      issues: ["Sin acceso configurado"],
      primaryIssue: "Sin acceso configurado",
      extraIssueCount: 0,
    };
  }
  return {
    label: "Saludable",
    tone: "healthy",
    issues: [],
    primaryIssue: null,
    extraIssueCount: 0,
  };
}
