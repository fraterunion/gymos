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
      dateLine: endDate ? `Termina el ${endDate}` : 'No renovará',
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
      if (m.cancelAtPeriodEnd) {
        return {
          label: 'Prueba · No renovará',
          tone: 'caution',
          dateLine: endDate ? `Termina el ${endDate}` : 'No renovará',
        };
      }
      return {
        label: 'Prueba',
        tone: 'neutral',
        dateLine: endDate ? `Tu prueba termina el ${endDate}` : null,
      };
    case 'PAST_DUE':
      if (m.cancelAtPeriodEnd) {
        return {
          label: 'Pago pendiente · No renovará',
          tone: 'caution',
          dateLine: endDate
            ? `El saldo pendiente sigue cobrable. No renueva después del ${endDate}`
            : 'El saldo pendiente sigue cobrable. No habrá renovaciones nuevas.',
        };
      }
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

/**
 * Membership tab mode. Guests and accounts with no current membership (the API's
 * `memberships` list: entitled, renewable, or scheduled) see the sales catalog.
 * Anyone the API still treats as holding a current membership sees management only.
 */
export type MembershipScreenMode = 'sales' | 'manage';

export function membershipScreenMode(input: {
  isGuest: boolean;
  currentMembershipCount: number;
}): MembershipScreenMode {
  if (!input.isGuest && input.currentMembershipCount > 0) return 'manage';
  return 'sales';
}

/**
 * Self-service "stop renewing" for a Stripe subscription that is still set to
 * renew. PAST_DUE is included so a failed renewal does not trap the member.
 * Cash, manual, paused, scheduled and already-ending rows are not offered this.
 * The server still re-checks the live Stripe status before anything is scheduled.
 */
export function canCancelStripeRenewal(
  membership: Pick<MembershipSummaryLike, 'source' | 'status' | 'cancelAtPeriodEnd'>,
): boolean {
  return (
    membership.source === 'STRIPE' &&
    (membership.status === 'ACTIVE' || membership.status === 'TRIALING' || membership.status === 'PAST_DUE') &&
    !membership.cancelAtPeriodEnd
  );
}

export function stripeRenewalCancelTargets<
  T extends Pick<MembershipSummaryLike, 'subscriptionId' | 'source' | 'status' | 'cancelAtPeriodEnd'>,
>(rows: readonly T[]): string[] {
  return rows.filter(canCancelStripeRenewal).map((row) => row.subscriptionId);
}

export function cancelRenewalSupport(status: string): string {
  if (status === 'PAST_DUE') {
    return 'Detiene renovaciones futuras. No borra facturas ya emitidas ni restaura el acceso.';
  }
  return 'Detiene renovaciones futuras. La membresía sigue hasta el fin del periodo pagado. Las facturas ya emitidas siguen siendo cobrables.';
}

export type OpenInvoiceCopy = {
  id: string;
  amountDueCents: number;
  currency: string;
};

function appendInvoicePoint(points: string[], invoices: readonly OpenInvoiceCopy[] | null, alreadyScheduled: boolean): void {
  if (invoices === null) {
    points.push(
      alreadyScheduled
        ? 'No pudimos consultar las facturas abiertas. Si existe alguna, sigue siendo cobrable.'
        : 'No pudimos consultar las facturas abiertas. No confirmes hasta ver el saldo.',
    );
    return;
  }
  if (invoices.length === 0) {
    points.push('En este momento Stripe no reporta facturas abiertas de esta suscripción.');
    return;
  }
  const lines = invoices.map((invoice) => invoiceMoney(invoice.amountDueCents, invoice.currency)).join(', ');
  points.push(`Facturas abiertas de esta suscripción: ${lines}. Siguen siendo cobrables.`);
}

function invoiceMoney(cents: number, currency: string): string {
  const code = (currency || 'mxn').toUpperCase();
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

export function cancelRenewalConfirmationCopy(input: {
  planName: string;
  localStatus: string;
  /** null = the invoice list is unknown. An empty list is not "you owe nothing forever". */
  invoices: readonly OpenInvoiceCopy[] | null;
  /** Set when this membership cannot be scheduled. The copy must not claim a cancellation. */
  blockedExplanation?: string | null;
  alreadyScheduled?: boolean;
}): {
  title: string;
  points: readonly string[];
  confirmLabel: string;
  dismissLabel: string;
} {
  if (input.blockedExplanation) {
    const points = [input.blockedExplanation, 'No se modificó ninguna factura.'];
    if (input.invoices && input.invoices.length > 0) {
      const lines = input.invoices
        .map((invoice) => invoiceMoney(invoice.amountDueCents, invoice.currency))
        .join(', ');
      points.push(`Facturas abiertas que siguen siendo cobrables: ${lines}.`);
    }
    return {
      title: 'No se puede programar la cancelación',
      points,
      confirmLabel: 'Confirmar cancelación',
      dismissLabel: 'Cerrar',
    };
  }
  if (input.alreadyScheduled) {
    const points = [
      `Stripe ya detuvo las renovaciones futuras de ${input.planName}.`,
      'Las facturas ya emitidas pueden seguir siendo cobrables. No se borran ni se condonan.',
    ];
    if (input.localStatus === 'PAST_DUE') {
      points.push('No restaura el acceso ni da por pagado el saldo pendiente.');
    }
    appendInvoicePoint(points, input.invoices, true);
    return {
      title: 'La renovación ya está cancelada',
      points,
      confirmLabel: 'Actualizar estado',
      dismissLabel: 'Cerrar',
    };
  }
  const points = [
    `Se detienen las renovaciones automáticas futuras de ${input.planName}.`,
    'Las facturas ya emitidas pueden seguir siendo cobrables. Esta acción no las borra, condona ni reembolsa.',
  ];
  if (input.localStatus === 'PAST_DUE') {
    points.push('No restaura el acceso ni da por pagado el saldo pendiente.');
  } else {
    points.push('El acceso del periodo ya pagado continúa hasta su fecha de término.');
  }
  appendInvoicePoint(points, input.invoices, false);
  return {
    title: 'Cancelar renovación automática',
    points,
    confirmLabel: 'Confirmar cancelación',
    dismissLabel: 'Mantener renovación',
  };
}

/** Success is only a verified Stripe flag plus a saved local row. */
export function cancelRenewalSucceeded(
  result: { verifiedAgainstStripe?: boolean; cancelAtPeriodEnd?: boolean } | null | undefined,
): boolean {
  return result?.verifiedAgainstStripe === true && result.cancelAtPeriodEnd === true;
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
