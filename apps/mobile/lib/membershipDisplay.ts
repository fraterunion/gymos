/**
 * MM-5 — pure presentation logic for MIS MEMBRESÍAS. No React/React Native imports so
 * these rules are testable with `node --test` (walletPassState pattern). The API is the
 * source of truth for every membership decision — this module only formats and orders
 * what the server already decided. It never derives compatibility, and internal
 * vocabulary (CORE/primary/exclusiveGroup) never appears in returned copy.
 */

export type MembershipTone = 'positive' | 'caution' | 'negative' | 'neutral';

export type MembershipSummaryLike = {
  subscriptionId: string;
  membershipPlanId: string;
  /** Internal ordering only — never rendered. */
  exclusiveGroup: string | null;
  status: string;
  source: string;
  isEntitled: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  entitlementEndsAt: string | null;
  effectiveEnd: string | null;
  cancelAtPeriodEnd: boolean;
  supersededBySubscriptionId: string | null;
  creditsUsed: number | null;
  creditsRemaining: number | null;
  plan: {
    id: string;
    name: string;
    priceCents: number;
    currency: string;
    billingInterval: string;
    classCredits: number | null;
    entitlementDays: number | null;
  };
  pendingPlan: { id: string; name: string } | null;
};

export type MembershipStatusDisplay = {
  /** Pill text — never color-only; always paired with the tone. */
  label: string;
  tone: MembershipTone;
  /** The one date/renewal line that matters for this state (null = nothing to say). */
  dateLine: string | null;
};

function fmtDate(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('es-MX', {
      day: 'numeric',
      month: 'long',
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleDateString();
  }
}

/**
 * Canonical member-facing status copy. The critical rule: CANCELED-but-entitled reads as
 * continuing access that will not renew — never a bare red "Cancelada" while the member
 * can still walk in.
 */
export function membershipStatusDisplay(
  m: Pick<
    MembershipSummaryLike,
    'status' | 'cancelAtPeriodEnd' | 'isEntitled' | 'effectiveEnd' | 'entitlementEndsAt' | 'currentPeriodEnd'
  > & { plan?: { entitlementDays: number | null } },
  opts: { now?: Date; timeZone?: string } = {},
): MembershipStatusDisplay {
  const now = opts.now ?? new Date();
  const end = m.effectiveEnd ?? m.entitlementEndsAt ?? m.currentPeriodEnd;
  const ended = end !== null && now >= new Date(end);
  const endDate = end ? fmtDate(end, opts.timeZone) : null;
  const fixedDuration = (m.plan?.entitlementDays ?? null) !== null;

  if (m.status === 'SCHEDULED') {
    const start = m.currentPeriodEnd; // not used; scheduled start handled by caller
    void start;
    return { label: 'Programada', tone: 'neutral', dateLine: null };
  }
  if (ended && (m.status === 'ACTIVE' || m.status === 'TRIALING' || m.status === 'CANCELED')) {
    return {
      label: 'Vencida',
      tone: 'negative',
      dateLine: endDate ? `Terminó el ${endDate}` : null,
    };
  }
  if (m.status === 'CANCELED' && m.isEntitled) {
    return {
      label: endDate ? `Activa hasta el ${endDate}` : 'Activa',
      tone: 'caution',
      dateLine: 'No renovará',
    };
  }
  if (m.status === 'ACTIVE' && m.cancelAtPeriodEnd && !fixedDuration) {
    return {
      label: 'Activa · No renovará',
      tone: 'caution',
      dateLine: endDate ? `Acceso hasta el ${endDate}` : null,
    };
  }
  switch (m.status) {
    case 'ACTIVE':
      return {
        label: 'Activa',
        tone: 'positive',
        dateLine: endDate
          ? fixedDuration
            ? `Válida hasta el ${endDate}`
            : `Renueva el ${endDate}`
          : null,
      };
    case 'TRIALING':
      return {
        label: 'Prueba',
        tone: 'neutral',
        dateLine: endDate ? `Tu prueba termina el ${endDate}` : null,
      };
    case 'PAST_DUE':
      return {
        label: 'Pago pendiente',
        tone: 'caution',
        dateLine: 'Actualiza tu método de pago para conservar el acceso',
      };
    case 'PAUSED':
      return { label: 'Pausada', tone: 'neutral', dateLine: 'Tu membresía está en pausa' };
    case 'CANCELED':
      return { label: 'Cancelada', tone: 'negative', dateLine: null };
    default:
      return { label: m.status, tone: 'neutral', dateLine: null };
  }
}

/** Per-membership credits copy — credits are NEVER aggregated across memberships. */
export function membershipCreditsDisplay(
  classCredits: number | null,
  creditsUsed: number | null,
  creditsRemaining: number | null,
): { primary: string; secondary: string | null } {
  if (classCredits === null) {
    return { primary: 'Clases ilimitadas', secondary: null };
  }
  if (typeof creditsUsed === 'number' && typeof creditsRemaining === 'number') {
    return {
      primary: `${creditsRemaining} de ${classCredits} créditos disponibles`,
      secondary: `${creditsUsed} usados en este periodo`,
    };
  }
  return { primary: `${classCredits} créditos por periodo`, secondary: null };
}

export function paymentSourceLine(source: string): string {
  switch (source) {
    case 'STRIPE':
      return 'Pago con tarjeta';
    case 'CASH':
      return 'Pago en el estudio';
    case 'MANUAL':
      return 'Asignada por el estudio';
    default:
      return '';
  }
}

export function membershipPriceLine(plan: {
  priceCents: number;
  currency: string;
  billingInterval: string;
  entitlementDays: number | null;
}): string {
  const code = (plan.currency || 'mxn').toUpperCase();
  let money: string;
  try {
    money = new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(plan.priceCents / 100);
  } catch {
    money = `${(plan.priceCents / 100).toFixed(0)} ${code}`;
  }
  if (plan.entitlementDays !== null) {
    return `${money} · ${plan.entitlementDays} días`;
  }
  switch (plan.billingInterval) {
    case 'MONTHLY':
      return `${money} /mes`;
    case 'YEARLY':
      return `${money} /año`;
    case 'WEEKLY':
      return `${money} /sem`;
    default:
      return money;
  }
}

/**
 * Display ordering: the base (group-holding) entitled membership first, then other
 * entitled memberships, then renewable-but-not-entitled ones. SCHEDULED rows are
 * excluded here — they render attached to their family via attachScheduledSuccessors.
 */
export function orderMembershipsForDisplay<T extends MembershipSummaryLike>(rows: readonly T[]): T[] {
  const nonScheduled = rows.filter((r) => r.status !== 'SCHEDULED');
  const rank = (r: T): number => {
    if (r.isEntitled && r.exclusiveGroup !== null) return 0;
    if (r.isEntitled) return 1;
    return 2;
  };
  return [...nonScheduled].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return a.subscriptionId.localeCompare(b.subscriptionId);
  });
}

/**
 * Attach each SCHEDULED successor to the membership whose supersededBySubscriptionId
 * points at it (fallback: same plan). A successor with no parent renders standalone last.
 */
export function attachScheduledSuccessors<T extends MembershipSummaryLike>(
  rows: readonly T[],
): { memberships: Array<{ membership: T; successor: T | null }>; orphanSuccessors: T[] } {
  const scheduled = rows.filter((r) => r.status === 'SCHEDULED');
  const ordered = orderMembershipsForDisplay(rows);
  const claimed = new Set<string>();

  const memberships = ordered.map((membership) => {
    const successor =
      scheduled.find((s) => membership.supersededBySubscriptionId === s.subscriptionId) ??
      scheduled.find((s) => !claimed.has(s.subscriptionId) && s.membershipPlanId === membership.membershipPlanId) ??
      null;
    if (successor) claimed.add(successor.subscriptionId);
    return { membership, successor };
  });
  const orphanSuccessors = scheduled.filter((s) => !claimed.has(s.subscriptionId));
  return { memberships, orphanSuccessors };
}

export function scheduledSuccessorLine(
  successor: Pick<MembershipSummaryLike, 'currentPeriodStart' | 'source'>,
  opts: { timeZone?: string } = {},
): string {
  const start = successor.currentPeriodStart ? fmtDate(successor.currentPeriodStart, opts.timeZone) : null;
  const method = successor.source === 'CASH' ? 'Cambia a pago en el estudio' : 'Nueva etapa programada';
  return start ? `${method} el ${start}` : method;
}

// ── Catalog CTAs — render the server's purchaseAction verbatim ─────────────────

export type PurchaseActionLike =
  | 'SUBSCRIBE'
  | 'CURRENT'
  | 'RENEW'
  | 'CHANGE'
  | 'ADD'
  | 'SCHEDULED'
  | 'BLOCKED';

export function purchaseCtaLabel(action: PurchaseActionLike): string {
  switch (action) {
    case 'SUBSCRIBE':
      return 'Suscribirme';
    case 'CURRENT':
      return 'Plan actual';
    case 'RENEW':
      return 'Renovar';
    case 'CHANGE':
      return 'Cambiar plan';
    case 'ADD':
      return 'Agregar membresía';
    case 'SCHEDULED':
      return 'Programada';
    case 'BLOCKED':
      return 'No disponible';
  }
}

export function isPurchaseActionDisabled(action: PurchaseActionLike): boolean {
  return action === 'CURRENT' || action === 'SCHEDULED' || action === 'BLOCKED';
}

export function blockedReasonCopy(reasonCode: string | null): string | null {
  switch (reasonCode) {
    case 'PAST_DUE':
      return 'Tienes un pago pendiente. Regularízalo para continuar.';
    case 'PAUSED':
      return 'Tu membresía está en pausa. Consulta en recepción.';
    case 'IN_PERSON':
      return 'Gestiona este cambio en recepción.';
    case 'STACKING_DISABLED':
      return 'Disponible próximamente. Consulta en recepción.';
    default:
      return null;
  }
}

/** Confirmation copy for ADD — must never imply replacement. */
export function addConfirmationCopy(input: {
  planName: string;
  keptPlanNames: readonly string[];
}): { title: string; body: string; keptLine: string | null } {
  const kept =
    input.keptPlanNames.length === 1
      ? `Tu ${input.keptPlanNames[0]} seguirá activa, sin cambios.`
      : input.keptPlanNames.length > 1
        ? 'Tus membresías actuales seguirán activas, sin cambios.'
        : null;
  return {
    title: `Agregar ${input.planName}`,
    body: `${input.planName} se agregará a tus membresías.`,
    keptLine: kept,
  };
}

/** Confirmation copy for CHANGE — names both plans explicitly. */
export function changeConfirmationCopy(input: {
  currentPlanName: string;
  targetPlanName: string;
}): { title: string; body: string } {
  return {
    title: `Cambiar ${input.currentPlanName} → ${input.targetPlanName}`,
    body: `Tu plan ${input.currentPlanName} cambiará a ${input.targetPlanName}. El cambio se aplica según tu ciclo de facturación.`,
  };
}

/** Booking attribution — spoken only when a scarce credit is consumed. */
export function bookingChargeLine(
  charged: { planName: string; creditConsumed: boolean } | null | undefined,
): string | null {
  if (!charged || !charged.creditConsumed) return null;
  return `Usará 1 crédito de ${charged.planName}`;
}

/** Mi Pase subtitle: primary plan plus a compact count of additional memberships. */
export function passPlanLine(
  primaryPlanName: string | null,
  totalCurrentMemberships: number,
): string | null {
  if (!primaryPlanName) return null;
  const extra = totalCurrentMemberships - 1;
  return extra > 0 ? `${primaryPlanName} · +${extra} membresía${extra > 1 ? 's' : ''}` : primaryPlanName;
}

/** Staff sale relationship header — makes add vs change vs renew unmistakable at the desk. */
export function staffSaleRelationshipCopy(input: {
  action: PurchaseActionLike;
  planName: string;
  relatedPlanName: string | null;
  memberName?: string | null;
}): { title: string; note: string | null } {
  const who = input.memberName ?? 'el miembro';
  switch (input.action) {
    case 'ADD':
      return {
        title: `Agregar ${input.planName}`,
        note: `Las membresías actuales de ${who} no se modifican.`,
      };
    case 'CHANGE':
      return {
        title: `Cambiar ${input.relatedPlanName ?? 'plan actual'} → ${input.planName}`,
        note: null,
      };
    case 'RENEW':
      return { title: `Renovar ${input.planName}`, note: null };
    case 'CURRENT':
      return { title: input.planName, note: `${who} ya tiene este plan activo.` };
    case 'SCHEDULED':
      return { title: input.planName, note: 'Ya hay un cambio programado para este plan.' };
    case 'BLOCKED':
      return { title: input.planName, note: 'Revisa el estado de la membresía antes de vender.' };
    default:
      return { title: `Nueva membresía: ${input.planName}`, note: null };
  }
}
