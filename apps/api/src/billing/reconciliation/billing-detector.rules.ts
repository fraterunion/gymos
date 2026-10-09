import { SubscriptionEndReason, SubscriptionStatus } from '@prisma/client';
import type { ObservedIssue } from './billing-case.types';
import { formatDateEs, formatMoney } from './billing-case-copy';
import { RENEWABLE_SUBSCRIPTION_STATUSES } from '../subscription-lifecycle.constants';
import { isTerminalStripeStatus } from '../stale-subscription-event';
import { expectedEndReasonFromStripe } from '../subscription-end-reason';
import { isSupersededSubscription } from '../paid-invoice-policy';

/**
 * Pure detection rules. Every rule takes already-loaded, PII-free snapshots and returns
 * ObservedIssues; the service around them does the (bounded) IO. Keeping the rules pure is what
 * makes false-positive policy testable: cash rows, trials, scheduled cancellations, grandfathered
 * prices, multi-membership siblings and Stripe-to-cash transitions all have explicit exclusions.
 */

export const RENEWABLE_STRIPE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']);

export type LocalSubscriptionSnapshot = {
  id: string;
  userId: string;
  membershipPlanId: string;
  planName: string;
  exclusiveGroupKey: string | null;
  isFixedDuration: boolean;
  status: SubscriptionStatus;
  source: string;
  stripeSubscriptionId: string | null;
  endReason: SubscriptionEndReason | null;
  supersededBySubscriptionId: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  entitlementEndsAt: Date | null;
  updatedAt: Date;
};

export type StripeSubscriptionSnapshot = {
  id: string;
  customerId: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  cancellationReason: string | null;
  currentPeriodEnd: Date | null;
  metadataStudioId: string | null;
  metadataUserId: string | null;
  metadataPlanId: string | null;
  priceId: string | null;
  latestInvoiceId: string | null;
};

export type MemberSnapshot = {
  userId: string;
  stripeCustomerId: string;
  /** Stripe said the customer id does not exist (`No such customer`). */
  customerMissingInStripe: boolean;
};

export type PaymentSnapshot = {
  id: string;
  userId: string;
  subscriptionId: string | null;
  membershipPlanId: string | null;
  stripeInvoiceId: string | null;
  amountCents: number;
  currency: string;
  status: string;
  paidAt: Date | null;
  createdAt: Date;
};

export type CycleSnapshot = { id: string; subscriptionId: string; userId: string; membershipPlanId: string; startsAt: Date; endsAt: Date; stripeInvoiceId: string | null };

export type DeletedEventSnapshot = { stripeEventId: string; stripeSubscriptionId: string; status: string; cancellationReason: string | null; createdAt: Date };

export type FailedInvoiceSnapshot = { stripeInvoiceId: string; stripeSubscriptionId: string | null; attempts: number; lastAttemptAt: Date; nextPaymentAttempt: Date | null };

export type OpenInvoiceSnapshot = { id: string; customerId: string; stripeSubscriptionId: string | null; amountRemainingCents: number; currency: string; createdAt: Date; attemptCount: number; nextPaymentAttempt: Date | null; autoAdvance: boolean };

export type StoredEventSnapshot = { stripeEventId: string; eventType: string; createdAt: Date; attemptCount: number; lastError: string | null; studioId: string | null };

export type RulesContext = { studioId: string; now: Date; timeZone: string };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function isRenewable(status: SubscriptionStatus): boolean {
  return RENEWABLE_SUBSCRIPTION_STATUSES.includes(status);
}

function base(ctx: RulesContext, partial: Omit<ObservedIssue, 'studioId'>): ObservedIssue {
  return { studioId: ctx.studioId, ...partial };
}

// ── 1. Stripe canceled / unknown while GymOS keeps the row renewable ────────────

export function detectStripeCanceledLocalAlive(
  ctx: RulesContext,
  locals: LocalSubscriptionSnapshot[],
  stripeById: Map<string, StripeSubscriptionSnapshot>,
  membersByUserId: Map<string, MemberSnapshot>,
): ObservedIssue[] {
  const issues: ObservedIssue[] = [];
  for (const row of locals) {
    if (row.source !== 'STRIPE' || !row.stripeSubscriptionId || !isRenewable(row.status)) continue;
    const member = membersByUserId.get(row.userId);
    if (!member || member.customerMissingInStripe) continue; // identity rule reports this
    const stripe = stripeById.get(row.stripeSubscriptionId);
    if (stripe && !isTerminalStripeStatus(stripe.status)) continue;
    const reasonCode = stripe ? 'STRIPE_CANCELED' : 'STRIPE_SUBSCRIPTION_NOT_FOUND';
    issues.push(
      base(ctx, {
        category: 'STRIPE_CANCELED_LOCAL_ALIVE',
        severity: 'HIGH',
        reasonCode,
        issueRef: row.id,
        userId: row.userId,
        subscriptionId: row.id,
        stripeSubscriptionId: row.stripeSubscriptionId,
        stripeCustomerId: member.stripeCustomerId,
        title: stripe
          ? `Stripe canceló ${row.planName}, pero GymOS la muestra como «${row.status}»`
          : `Stripe ya no reconoce la suscripción de ${row.planName} que GymOS muestra como «${row.status}»`,
        summary: stripe
          ? `Stripe terminó la suscripción el ${formatDateEs(stripe.canceledAt, ctx.timeZone)} (${stripe.cancellationReason ?? 'sin motivo'}). GymOS la sigue tratando como renovable; no habrá más cobros ni renovaciones.`
          : 'Stripe no devuelve esta suscripción para el cliente. GymOS la sigue tratando como renovable.',
        suggestedAction:
          'Confirma en Stripe y marca la membresía como cancelada en GymOS (o véndela de nuevo si el miembro quiere continuar). No registres cobros manuales sobre esta fila.',
        evidence: {
          localStatus: row.status,
          localPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
          stripeStatus: stripe?.status ?? 'not_found',
          stripeCanceledAt: stripe?.canceledAt?.toISOString() ?? null,
          stripeCancellationReason: stripe?.cancellationReason ?? null,
        },
      }),
    );
  }
  return issues;
}

// ── 2. GymOS canceled while Stripe keeps the subscription alive (and billing) ──

export function detectLocalCanceledStripeAlive(
  ctx: RulesContext,
  locals: LocalSubscriptionSnapshot[],
  stripeById: Map<string, StripeSubscriptionSnapshot>,
): ObservedIssue[] {
  const issues: ObservedIssue[] = [];
  const localByStripeId = new Map(locals.filter((l) => l.stripeSubscriptionId).map((l) => [l.stripeSubscriptionId!, l]));
  for (const stripe of stripeById.values()) {
    if (!RENEWABLE_STRIPE_STATUSES.has(stripe.status)) continue;
    const local = localByStripeId.get(stripe.id);
    if (!local || local.status !== SubscriptionStatus.CANCELED) continue;
    // Stripe→cash at period end: GymOS ends the row when the period lapses while Stripe's own
    // deletion event may still be minutes away. Give that handoff a day before calling it drift.
    if (stripe.cancelAtPeriodEnd && stripe.currentPeriodEnd && ctx.now.getTime() - stripe.currentPeriodEnd.getTime() < DAY_MS) continue;
    issues.push(
      base(ctx, {
        category: 'LOCAL_CANCELED_STRIPE_ALIVE',
        severity: 'HIGH',
        reasonCode: 'LOCAL_CANCELED',
        issueRef: local.id,
        userId: local.userId,
        subscriptionId: local.id,
        stripeSubscriptionId: stripe.id,
        stripeCustomerId: stripe.customerId,
        title: `GymOS canceló ${local.planName}, pero Stripe la mantiene vigente`,
        summary: `GymOS tiene la membresía cancelada (${local.endReason ?? 'sin motivo'}) y Stripe la reporta como «${stripe.status}»${stripe.cancelAtPeriodEnd ? ' con cancelación programada' : ''}. Mientras siga vigente en Stripe, puede seguir cobrando al miembro${stripe.currentPeriodEnd ? ` (periodo actual hasta el ${formatDateEs(stripe.currentPeriodEnd, ctx.timeZone)})` : ''}.`,
        suggestedAction:
          'Cancela la suscripción en Stripe si la membresía ya no aplica, o corrige la membresía en GymOS si el miembro sí debe tener acceso. No cobres manualmente.',
        evidence: {
          localStatus: local.status,
          localEndReason: local.endReason,
          stripeStatus: stripe.status,
          stripeCancelAtPeriodEnd: stripe.cancelAtPeriodEnd,
          stripeCurrentPeriodEnd: stripe.currentPeriodEnd?.toISOString() ?? null,
        },
      }),
    );
  }
  return issues;
}

// ── 3 + 12. Identity: orphans, duplicates, metadata and customer mismatches ─────

export function detectIdentityMismatches(
  ctx: RulesContext,
  locals: LocalSubscriptionSnapshot[],
  stripeSubs: StripeSubscriptionSnapshot[],
  members: MemberSnapshot[],
  planGroupById: Map<string, string | null>,
): ObservedIssue[] {
  const issues: ObservedIssue[] = [];
  const localByStripeId = new Map(locals.filter((l) => l.stripeSubscriptionId).map((l) => [l.stripeSubscriptionId!, l]));
  const customerToUser = new Map(members.map((m) => [m.stripeCustomerId, m.userId]));

  for (const member of members) {
    if (!member.customerMissingInStripe) continue;
    const renewable = locals.filter((l) => l.userId === member.userId && l.source === 'STRIPE' && isRenewable(l.status));
    if (renewable.length === 0) continue;
    issues.push(
      base(ctx, {
        category: 'SUBSCRIPTION_IDENTITY_MISMATCH',
        severity: 'LOW',
        reasonCode: 'STRIPE_CUSTOMER_NOT_FOUND',
        issueRef: `customer:${member.stripeCustomerId}`,
        userId: member.userId,
        stripeCustomerId: member.stripeCustomerId,
        title: 'El cliente de Stripe de este miembro no existe',
        summary: `GymOS tiene ${renewable.length} membresía(s) de tarjeta vigentes para un cliente que Stripe no reconoce (típico de cuentas de prueba o de otra cuenta de Stripe).`,
        suggestedAction: 'Si es una cuenta de prueba, márcala como excluida de analítica; si es un miembro real, vuelve a vincular su cliente de Stripe.',
        evidence: { renewableLocalSubscriptionIds: renewable.map((r) => r.id) },
      }),
    );
  }

  // Alive Stripe subscriptions grouped per member for duplicate detection.
  const aliveByUser = new Map<string, StripeSubscriptionSnapshot[]>();
  for (const s of stripeSubs) {
    if (!RENEWABLE_STRIPE_STATUSES.has(s.status)) continue;
    if (s.metadataStudioId && s.metadataStudioId !== ctx.studioId) continue; // another tenant's membership
    const local = localByStripeId.get(s.id);
    const userId = local?.userId ?? customerToUser.get(s.customerId) ?? null;

    if (!local) {
      issues.push(
        base(ctx, {
          category: 'SUBSCRIPTION_IDENTITY_MISMATCH',
          severity: 'HIGH',
          reasonCode: 'STRIPE_ORPHAN',
          issueRef: s.id,
          userId,
          stripeSubscriptionId: s.id,
          stripeCustomerId: s.customerId,
          title: 'Stripe cobra una suscripción que GymOS no tiene registrada',
          summary: `La suscripción ${s.id} está «${s.status}» en Stripe, pero no existe una membresía ligada a ella en GymOS: el miembro paga y GymOS no le reconoce acceso por esta suscripción.`,
          suggestedAction: 'Revisa si es un duplicado (cancelar en Stripe) o una membresía real que falta en GymOS (crear/vincular). Nunca cobres de nuevo.',
          evidence: { stripeStatus: s.status, metadataPlanId: s.metadataPlanId, priceId: s.priceId, currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null },
        }),
      );
    } else {
      if ((s.metadataUserId && s.metadataUserId !== local.userId) || (s.metadataStudioId && s.metadataStudioId !== ctx.studioId)) {
        issues.push(
          base(ctx, {
            category: 'SUBSCRIPTION_IDENTITY_MISMATCH',
            severity: 'HIGH',
            reasonCode: 'METADATA_MISMATCH',
            issueRef: s.id,
            userId: local.userId,
            subscriptionId: local.id,
            stripeSubscriptionId: s.id,
            stripeCustomerId: s.customerId,
            title: 'La suscripción de Stripe apunta a otro miembro o estudio',
            summary: 'Los metadatos de Stripe (miembro/estudio) no coinciden con la membresía ligada en GymOS.',
            suggestedAction: 'Verifica a quién pertenece la suscripción antes de cualquier cambio; corrige el vínculo en GymOS.',
            evidence: { metadataUserId: s.metadataUserId, metadataStudioId: s.metadataStudioId, localUserId: local.userId },
          }),
        );
      }
      const expectedCustomer = members.find((m) => m.userId === local.userId)?.stripeCustomerId ?? null;
      if (expectedCustomer && expectedCustomer !== s.customerId) {
        issues.push(
          base(ctx, {
            category: 'SUBSCRIPTION_IDENTITY_MISMATCH',
            severity: 'HIGH',
            reasonCode: 'CUSTOMER_MISMATCH',
            issueRef: `${s.id}:customer`,
            userId: local.userId,
            subscriptionId: local.id,
            stripeSubscriptionId: s.id,
            stripeCustomerId: s.customerId,
            title: 'La suscripción pertenece a otro cliente de Stripe',
            summary: 'La suscripción ligada a este miembro se cobra a un cliente de Stripe distinto al registrado en su perfil.',
            suggestedAction: 'Confirma qué cliente de Stripe es el correcto y corrige el vínculo.',
            evidence: { subscriptionCustomerId: s.customerId, memberCustomerId: expectedCustomer },
          }),
        );
      }
    }
    if (userId) aliveByUser.set(userId, [...(aliveByUser.get(userId) ?? []), s]);
  }

  // Duplicate renewable: two alive Stripe subscriptions in the same plan family for one member.
  for (const [userId, subs] of aliveByUser) {
    if (subs.length < 2) continue;
    const familyOf = (s: StripeSubscriptionSnapshot): string | null => {
      const local = localByStripeId.get(s.id);
      const planId = local?.membershipPlanId ?? s.metadataPlanId;
      if (!planId) return null;
      const group = local ? local.exclusiveGroupKey : planGroupById.get(planId) ?? null;
      return group ? `group:${group}` : `plan:${planId}`;
    };
    const byFamily = new Map<string, StripeSubscriptionSnapshot[]>();
    for (const s of subs) {
      const key = familyOf(s);
      if (!key) continue;
      byFamily.set(key, [...(byFamily.get(key) ?? []), s]);
    }
    for (const [family, dup] of byFamily) {
      if (dup.length < 2) continue;
      issues.push(
        base(ctx, {
          category: 'SUBSCRIPTION_IDENTITY_MISMATCH',
          severity: 'HIGH',
          reasonCode: 'DUPLICATE_RENEWABLE',
          issueRef: `${userId}:${family}`,
          userId,
          stripeCustomerId: dup[0]!.customerId,
          title: 'El miembro tiene dos suscripciones de Stripe vigentes para la misma membresía',
          summary: `Stripe cobra ${dup.length} suscripciones (${dup.map((d) => d.id).join(', ')}) que compiten por la misma membresía: riesgo de cobro doble.`,
          suggestedAction: 'Conserva una sola suscripción en Stripe y cancela la otra; revisa si procede un reembolso.',
          evidence: { stripeSubscriptionIds: dup.map((d) => d.id), family },
        }),
      );
    }
  }
  return issues;
}

// ── 4/5. Paid without entitlement (monthly + unattributed) and stale periods ────

export function detectMonthlyPaidWithoutEntitlement(
  ctx: RulesContext,
  payments: PaymentSnapshot[],
  locals: LocalSubscriptionSnapshot[],
  opts: {
    ledgerStartedAt: Date;
    unattributedGraceMs?: number;
    /** When Stripe ended each subscription (stored deletion events): immutable, unlike updatedAt. */
    endedAtByStripeSubscription?: Map<string, Date>;
  },
): ObservedIssue[] {
  const issues: ObservedIssue[] = [];
  const grace = opts.unattributedGraceMs ?? 30 * 60_000;
  const localById = new Map(locals.map((l) => [l.id, l]));
  const endedAt = (row: LocalSubscriptionSnapshot): Date =>
    (row.stripeSubscriptionId ? opts.endedAtByStripeSubscription?.get(row.stripeSubscriptionId) : undefined) ?? row.updatedAt;
  for (const p of payments) {
    if (p.status !== 'SUCCEEDED' || !p.stripeInvoiceId || p.amountCents <= 0) continue;
    const paidAt = p.paidAt ?? p.createdAt;
    if (paidAt < opts.ledgerStartedAt) continue;

    if (!p.subscriptionId) {
      // Unattributed: only a problem when the member has NO card membership row at all. A first
      // invoice keeps the plan it was billed under even after a plan change on the same Stripe
      // subscription moves the row to another plan, so the plan is deliberately not compared.
      if (ctx.now.getTime() - paidAt.getTime() < grace) continue;
      const anyRow = locals.some((l) => l.userId === p.userId && l.source === 'STRIPE');
      if (anyRow) continue;
      issues.push(
        base(ctx, {
          category: 'PAID_WITHOUT_ENTITLEMENT',
          severity: 'CRITICAL',
          reasonCode: 'NO_LOCAL_SUBSCRIPTION',
          issueRef: p.stripeInvoiceId,
          userId: p.userId,
          paymentId: p.id,
          stripeInvoiceId: p.stripeInvoiceId,
          title: `Pago recibido sin acceso: ${formatMoney(p.amountCents, p.currency)} sin membresía en GymOS`,
          summary: `Stripe cobró la factura ${p.stripeInvoiceId} el ${formatDateEs(paidAt, ctx.timeZone)}, pero GymOS no tiene una membresía de tarjeta para este miembro y plan.`,
          suggestedAction: 'Crea o vincula la membresía correcta en GymOS, o reembolsa en Stripe si el cobro no debió ocurrir. No cobres de nuevo.',
          evidence: { amountCents: p.amountCents, currency: p.currency, paidAt: paidAt.toISOString(), membershipPlanId: p.membershipPlanId, entitlementGranted: false, whyNotGranted: 'NO_LOCAL_SUBSCRIPTION' },
        }),
      );
      continue;
    }

    const row = localById.get(p.subscriptionId);
    if (!row || row.isFixedDuration) continue; // fixed-duration rows are covered by the cycle ledger rule
    const ended = row.status === SubscriptionStatus.CANCELED || isSupersededSubscription(row);
    if (ended) {
      const afterLastPeriod = row.currentPeriodEnd ? paidAt > row.currentPeriodEnd : false;
      const afterEnd = paidAt > endedAt(row);
      if (!afterLastPeriod && !afterEnd) continue; // paid while the membership was live: fine
      issues.push(
        base(ctx, {
          category: 'PAID_WITHOUT_ENTITLEMENT',
          severity: 'CRITICAL',
          reasonCode: isSupersededSubscription(row) ? 'SUPERSEDED_MEMBERSHIP' : 'SUBSCRIPTION_ENDED',
          issueRef: p.stripeInvoiceId,
          userId: p.userId,
          subscriptionId: row.id,
          paymentId: p.id,
          stripeInvoiceId: p.stripeInvoiceId,
          stripeSubscriptionId: row.stripeSubscriptionId,
          title: `Pago recibido sin acceso: ${formatMoney(p.amountCents, p.currency)} de ${row.planName}`,
          summary: `Stripe cobró la factura ${p.stripeInvoiceId} el ${formatDateEs(paidAt, ctx.timeZone)} de una membresía que GymOS tiene cancelada/reemplazada (${row.endReason ?? 'sin motivo'}); el acceso no se restauró.`,
          suggestedAction: 'Decide con el miembro: reembolsa en Stripe o vende/activa la membresía correcta en GymOS. No reactives la suscripción cancelada.',
          evidence: { amountCents: p.amountCents, currency: p.currency, paidAt: paidAt.toISOString(), localStatus: row.status, localEndReason: row.endReason, localPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null, entitlementGranted: false },
        }),
      );
      continue;
    }
    if (isRenewable(row.status) && row.currentPeriodEnd && paidAt.getTime() > row.currentPeriodEnd.getTime() + 36 * HOUR_MS) {
      issues.push(
        base(ctx, {
          category: 'STALE_RENEWAL_PERIOD',
          severity: 'HIGH',
          reasonCode: 'PERIOD_NOT_ADVANCED_AFTER_PAYMENT',
          issueRef: row.id,
          userId: p.userId,
          subscriptionId: row.id,
          paymentId: p.id,
          stripeInvoiceId: p.stripeInvoiceId,
          stripeSubscriptionId: row.stripeSubscriptionId,
          title: `Stripe cobró la renovación de ${row.planName}, pero la vigencia en GymOS no avanzó`,
          summary: `El pago del ${formatDateEs(paidAt, ctx.timeZone)} es posterior al fin de la vigencia registrada (${formatDateEs(row.currentPeriodEnd, ctx.timeZone)}); el evento de renovación de Stripe no se aplicó.`,
          suggestedAction: 'Revisa los webhooks de Stripe (customer.subscription.updated) de esta suscripción; si están fallidos, reenvíalos desde Stripe.',
          evidence: { paidAt: paidAt.toISOString(), localPeriodEnd: row.currentPeriodEnd.toISOString(), localStatus: row.status },
        }),
      );
    }
  }
  return issues;
}

export function detectStalePeriods(
  ctx: RulesContext,
  locals: LocalSubscriptionSnapshot[],
  stripeById: Map<string, StripeSubscriptionSnapshot>,
): ObservedIssue[] {
  const issues: ObservedIssue[] = [];
  for (const row of locals) {
    if (row.source !== 'STRIPE' || !row.stripeSubscriptionId || !isRenewable(row.status) || row.isFixedDuration) continue;
    const stripe = stripeById.get(row.stripeSubscriptionId);
    if (!stripe || !RENEWABLE_STRIPE_STATUSES.has(stripe.status) || !stripe.currentPeriodEnd || !row.currentPeriodEnd) continue;
    const aheadMs = stripe.currentPeriodEnd.getTime() - row.currentPeriodEnd.getTime();
    if (aheadMs <= 36 * HOUR_MS) continue;
    issues.push(
      base(ctx, {
        category: 'STALE_RENEWAL_PERIOD',
        severity: 'MEDIUM',
        reasonCode: 'STRIPE_PERIOD_AHEAD',
        issueRef: row.id,
        userId: row.userId,
        subscriptionId: row.id,
        stripeSubscriptionId: stripe.id,
        stripeCustomerId: stripe.customerId,
        title: `La vigencia de ${row.planName} en GymOS está atrasada respecto a Stripe`,
        summary: `Stripe ya está en un periodo que termina el ${formatDateEs(stripe.currentPeriodEnd, ctx.timeZone)}; GymOS sigue en uno que terminó el ${formatDateEs(row.currentPeriodEnd, ctx.timeZone)}. El miembro podría ver su membresía como vencida.`,
        suggestedAction: 'Revisa los webhooks de Stripe de esta suscripción; reenvía el último customer.subscription.updated si falló.',
        evidence: { localPeriodEnd: row.currentPeriodEnd.toISOString(), stripePeriodEnd: stripe.currentPeriodEnd.toISOString(), localStatus: row.status, stripeStatus: stripe.status },
      }),
    );
  }
  return issues;
}

// ── 6. Overlapping entitlement cycles (same member, same plan, different rows) ──

export function detectOverlappingCycles(ctx: RulesContext, cycles: CycleSnapshot[]): ObservedIssue[] {
  const issues: ObservedIssue[] = [];
  const byMemberPlan = new Map<string, CycleSnapshot[]>();
  for (const c of cycles) {
    const key = `${c.userId}:${c.membershipPlanId}`;
    byMemberPlan.set(key, [...(byMemberPlan.get(key) ?? []), c]);
  }
  for (const [key, list] of byMemberPlan) {
    const sorted = [...list].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (cur.startsAt.getTime() >= prev.endsAt.getTime() - 1000) continue;
      issues.push(
        base(ctx, {
          category: 'OVERLAPPING_ENTITLEMENT_CYCLES',
          severity: 'MEDIUM',
          reasonCode: prev.subscriptionId === cur.subscriptionId ? 'SAME_SUBSCRIPTION' : 'CROSS_SUBSCRIPTION',
          issueRef: `${prev.id}:${cur.id}`,
          userId: cur.userId,
          subscriptionId: cur.subscriptionId,
          stripeInvoiceId: cur.stripeInvoiceId,
          title: 'Dos vigencias pagadas se enciman para el mismo plan',
          summary: `La vigencia ${formatDateEs(cur.startsAt, ctx.timeZone)} → ${formatDateEs(cur.endsAt, ctx.timeZone)} empieza antes de que termine la anterior (${formatDateEs(prev.endsAt, ctx.timeZone)}). Puede ser un cobro doble o dos membresías para el mismo periodo.`,
          suggestedAction: 'Revisa ambos cobros; si hay un duplicado, valora reembolso o extensión manual de la vigencia.',
          evidence: { key, previousCycleId: prev.id, currentCycleId: cur.id, previousEndsAt: prev.endsAt.toISOString(), currentStartsAt: cur.startsAt.toISOString() },
        }),
      );
    }
  }
  return issues;
}

// ── 7 + 8. Webhook dead letters and stuck claims ───────────────────────────────

export function detectWebhookProblems(
  ctx: Omit<RulesContext, 'studioId'> & { studioId: string | null },
  events: StoredEventSnapshot[],
  opts: { minAgeMs?: number } = {},
): ObservedIssue[] {
  const minAge = opts.minAgeMs ?? 30 * 60_000;
  const issues: ObservedIssue[] = [];
  for (const e of events) {
    if (ctx.now.getTime() - e.createdAt.getTime() < minAge) continue;
    const deadLetter = e.lastError !== null;
    const moneyEvent = e.eventType === 'invoice.paid' || e.eventType === 'payment_intent.succeeded';
    issues.push({
      studioId: e.studioId ?? ctx.studioId,
      category: deadLetter ? 'WEBHOOK_DEAD_LETTER' : 'WEBHOOK_BACKLOG',
      severity: deadLetter ? (moneyEvent ? 'CRITICAL' : 'MEDIUM') : 'MEDIUM',
      reasonCode: deadLetter ? (moneyEvent ? 'PAID_EVENT_UNPROCESSED' : 'HANDLER_FAILED') : 'STUCK_CLAIM',
      issueRef: e.stripeEventId,
      stripeEventId: e.stripeEventId,
      title: deadLetter ? `Webhook fallido: ${e.eventType} requiere intervención` : `Webhook sin procesar: ${e.eventType}`,
      summary: deadLetter
        ? `El evento ${e.stripeEventId} falló ${e.attemptCount} vez/veces (${(e.lastError ?? '').slice(0, 160)}).${moneyEvent ? ' Es un evento de cobro: puede haber un pago sin vigencia.' : ''}`
        : `El evento ${e.stripeEventId} se recibió el ${formatDateEs(e.createdAt, ctx.timeZone)} pero nunca terminó de procesarse.`,
      suggestedAction: deadLetter
        ? 'Revisa el error; si la causa ya se corrigió, reenvía el evento desde Stripe. Si no debe reprocesarse, márcalo como resuelto.'
        : 'Reenvía el evento desde Stripe; si vuelve a quedarse sin procesar, revisa los logs del API.',
      evidence: { eventType: e.eventType, attemptCount: e.attemptCount, lastError: e.lastError?.slice(0, 300) ?? null, receivedAt: e.createdAt.toISOString() },
    });
  }
  return issues;
}

// ── 9. Cancellation reason mismatch (analytics accuracy) ───────────────────────

export function detectCancellationReasonMismatch(
  ctx: RulesContext,
  locals: LocalSubscriptionSnapshot[],
  deletedEvents: DeletedEventSnapshot[],
): ObservedIssue[] {
  const issues: ObservedIssue[] = [];
  const latestDeletionBySub = new Map<string, DeletedEventSnapshot>();
  for (const e of deletedEvents) {
    const prev = latestDeletionBySub.get(e.stripeSubscriptionId);
    if (!prev || prev.createdAt < e.createdAt) latestDeletionBySub.set(e.stripeSubscriptionId, e);
  }
  for (const row of locals) {
    if (row.status !== SubscriptionStatus.CANCELED || !row.stripeSubscriptionId) continue;
    if (row.endReason !== null && row.endReason !== SubscriptionEndReason.MEMBER_CANCELLED) continue; // supersessions, staff, already-correct
    const deletion = latestDeletionBySub.get(row.stripeSubscriptionId);
    if (!deletion) continue;
    const expected = expectedEndReasonFromStripe({ status: deletion.status, cancellationReason: deletion.cancellationReason });
    if (!expected || expected === row.endReason) continue;
    issues.push(
      base(ctx, {
        category: 'CANCELLATION_REASON_MISMATCH',
        severity: 'LOW',
        reasonCode: `EXPECTED_${expected}`,
        issueRef: row.id,
        userId: row.userId,
        subscriptionId: row.id,
        stripeSubscriptionId: row.stripeSubscriptionId,
        stripeEventId: deletion.stripeEventId,
        title: `La baja de ${row.planName} está registrada como «${row.endReason ?? 'sin motivo'}», pero Stripe la terminó por ${deletion.cancellationReason ?? deletion.status}`,
        summary: 'Solo afecta la analítica de bajas (voluntaria vs. involuntaria); no cambia el acceso ni los cobros.',
        suggestedAction: 'Corrige el motivo con el backfill aprobado de motivos de cancelación (ejecución aparte, con aprobación).',
        evidence: { currentEndReason: row.endReason, expectedEndReason: expected, stripeCancellationReason: deletion.cancellationReason, stripeStatus: deletion.status, deletedAt: deletion.createdAt.toISOString() },
      }),
    );
  }
  return issues;
}

// ── 10. Open invoices on ended subscriptions ───────────────────────────────────

export function detectOpenInvoicesOnEndedSubscriptions(
  ctx: RulesContext,
  openInvoices: OpenInvoiceSnapshot[],
  stripeById: Map<string, StripeSubscriptionSnapshot>,
  locals: LocalSubscriptionSnapshot[],
): ObservedIssue[] {
  const issues: ObservedIssue[] = [];
  const localByStripeId = new Map(locals.filter((l) => l.stripeSubscriptionId).map((l) => [l.stripeSubscriptionId!, l]));
  for (const inv of openInvoices) {
    if (!inv.stripeSubscriptionId || inv.amountRemainingCents <= 0) continue;
    const stripe = stripeById.get(inv.stripeSubscriptionId);
    const local = localByStripeId.get(inv.stripeSubscriptionId);
    const ended = (stripe && isTerminalStripeStatus(stripe.status)) || local?.status === SubscriptionStatus.CANCELED;
    if (!ended) continue;
    issues.push(
      base(ctx, {
        category: 'OPEN_INVOICE_ON_ENDED_SUBSCRIPTION',
        severity: 'MEDIUM',
        reasonCode: inv.autoAdvance ? 'OPEN_INVOICE_STILL_COLLECTING' : 'OPEN_INVOICE_AFTER_CANCEL',
        issueRef: inv.id,
        userId: local?.userId ?? null,
        subscriptionId: local?.id ?? null,
        stripeSubscriptionId: inv.stripeSubscriptionId,
        stripeInvoiceId: inv.id,
        stripeCustomerId: inv.customerId,
        title: `Factura pendiente de revisión: ${formatMoney(inv.amountRemainingCents, inv.currency)} de una suscripción terminada`,
        summary: `La factura ${inv.id} (${formatDateEs(inv.createdAt, ctx.timeZone)}, ${inv.attemptCount} intento(s)) sigue abierta aunque la suscripción ya terminó. Si el miembro la paga, GymOS registrará el pago y NO restaurará el acceso automáticamente.`,
        suggestedAction: 'Decide en Stripe: anular (void) o marcar como incobrable si ya no procede; o acuerda con el miembro una nueva membresía antes de cobrarla.',
        evidence: { amountRemainingCents: inv.amountRemainingCents, currency: inv.currency, createdAt: inv.createdAt.toISOString(), attemptCount: inv.attemptCount, nextPaymentAttempt: inv.nextPaymentAttempt?.toISOString() ?? null, autoAdvance: inv.autoAdvance, stripeStatus: stripe?.status ?? null, localStatus: local?.status ?? null },
      }),
    );
  }
  return issues;
}

// ── 11. Repeated payment failures (dunning in progress, no success yet) ────────

export function detectRepeatedPaymentFailures(
  ctx: RulesContext,
  locals: LocalSubscriptionSnapshot[],
  failures: FailedInvoiceSnapshot[],
  succeededInvoiceIds: Set<string>,
  opts: { minAttempts?: number } = {},
): ObservedIssue[] {
  const minAttempts = opts.minAttempts ?? 3;
  const issues: ObservedIssue[] = [];
  const localByStripeId = new Map(locals.filter((l) => l.stripeSubscriptionId).map((l) => [l.stripeSubscriptionId!, l]));
  for (const f of failures) {
    if (f.attempts < minAttempts || succeededInvoiceIds.has(f.stripeInvoiceId)) continue;
    const local = f.stripeSubscriptionId ? localByStripeId.get(f.stripeSubscriptionId) : undefined;
    if (!local || local.status !== SubscriptionStatus.PAST_DUE) continue; // ended rows are covered elsewhere
    issues.push(
      base(ctx, {
        category: 'REPEATED_PAYMENT_FAILURES',
        severity: 'MEDIUM',
        reasonCode: 'DUNNING_IN_PROGRESS',
        issueRef: f.stripeInvoiceId,
        userId: local.userId,
        subscriptionId: local.id,
        stripeSubscriptionId: local.stripeSubscriptionId,
        stripeInvoiceId: f.stripeInvoiceId,
        title: `${f.attempts} cobros fallidos de ${local.planName}; el miembro sigue con pago pendiente`,
        summary: `Stripe no ha podido cobrar la factura ${f.stripeInvoiceId} (${f.attempts} intentos, el último el ${formatDateEs(f.lastAttemptAt, ctx.timeZone)}).${f.nextPaymentAttempt ? ` Próximo intento: ${formatDateEs(f.nextPaymentAttempt, ctx.timeZone)}.` : ' Stripe no programó más intentos.'}`,
        suggestedAction: 'Pide al miembro actualizar su tarjeta (portal de pagos de Stripe). No registres un cobro en efectivo sin cancelar la suscripción en Stripe.',
        evidence: { attempts: f.attempts, lastAttemptAt: f.lastAttemptAt.toISOString(), nextPaymentAttempt: f.nextPaymentAttempt?.toISOString() ?? null, localStatus: local.status },
      }),
    );
  }
  return issues;
}
