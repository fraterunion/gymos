import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BillingCaseCategory, PaymentMethod, PaymentStatus, SubscriptionSource } from '@prisma/client';
import type Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import { StripeService } from '../../stripe/stripe.service';
import { ENTITLEMENT_LEDGER_STARTED_AT, loadPaidWithoutEntitlement } from '../paid-without-entitlement';
import type { ObservedIssue } from './billing-case.types';
import { formatDateEs, formatMoney } from './billing-case-copy';
import {
  detectCancellationReasonMismatch,
  detectIdentityMismatches,
  detectLocalCanceledStripeAlive,
  detectMonthlyPaidWithoutEntitlement,
  detectOpenInvoicesOnEndedSubscriptions,
  detectOverlappingCycles,
  detectRepeatedPaymentFailures,
  detectStalePeriods,
  detectStripeCanceledLocalAlive,
  detectWebhookProblems,
  type CycleSnapshot,
  type DeletedEventSnapshot,
  type FailedInvoiceSnapshot,
  type LocalSubscriptionSnapshot,
  type MemberSnapshot,
  type OpenInvoiceSnapshot,
  type PaymentSnapshot,
  type RulesContext,
  type StoredEventSnapshot,
  type StripeSubscriptionSnapshot,
} from './billing-detector.rules';

export type DetectorCoverage = { category: BillingCaseCategory; complete: boolean; detail?: string };

export type StudioDetectionResult = {
  studioId: string;
  issues: ObservedIssue[];
  coverage: DetectorCoverage[];
  checkedMembers: number;
  skippedMembers: number;
  stripeCalls: number;
  stripeFailures: number;
  durationMs: number;
};

export type DetectOptions = {
  now?: Date;
  /** Wall-clock budget for the Stripe phase of one studio (default 8 minutes). */
  deadlineMs?: number;
  /** Concurrent Stripe customer lookups (default 4). */
  memberConcurrency?: number;
  /** Hard cap on members scanned per studio per run; the rest is logged as skipped. */
  maxMembers?: number;
};

const DAY_MS = 86_400_000;
const STRIPE_CATEGORIES: BillingCaseCategory[] = [
  'STRIPE_CANCELED_LOCAL_ALIVE',
  'LOCAL_CANCELED_STRIPE_ALIVE',
  'SUBSCRIPTION_IDENTITY_MISMATCH',
  'STALE_RENEWAL_PERIOD',
  'OPEN_INVOICE_ON_ENDED_SUBSCRIPTION',
];
const LOCAL_CATEGORIES: BillingCaseCategory[] = [
  'PAID_WITHOUT_ENTITLEMENT',
  'OVERLAPPING_ENTITLEMENT_CYCLES',
  'CANCELLATION_REASON_MISMATCH',
  'REPEATED_PAYMENT_FAILURES',
];

function unixToDate(value: number | null | undefined): Date | null {
  return typeof value === 'number' ? new Date(value * 1000) : null;
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  return typeof value === 'string' ? value : value?.id ?? null;
}

function readPath(payload: unknown, path: string[]): unknown {
  let cur: unknown = payload;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function readStudioIdFromPayload(payload: unknown): string | null {
  const candidates = [
    ['data', 'object', 'metadata', 'studioId'],
    ['data', 'object', 'parent', 'subscription_details', 'metadata', 'studioId'],
    ['data', 'object', 'subscription_details', 'metadata', 'studioId'],
  ];
  for (const path of candidates) {
    const value = readPath(payload, path);
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (index < items.length) {
      const item = items[index++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Bounded, read-only detection. Every Stripe access is a GET; nothing here writes to Stripe or to
 * membership/payment rows. Per studio: one `subscriptions.list(status=all)` per member with a
 * Stripe customer (bounded concurrency, 429 retry with backoff, wall-clock deadline), plus one
 * `invoices.list(status=open)` per customer that has an ended subscription in the last 120 days.
 */
@Injectable()
export class BillingDetectorsService {
  private readonly logger = new Logger(BillingDetectorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  async detectStudio(studioId: string, opts: DetectOptions = {}): Promise<StudioDetectionResult> {
    const startedAt = Date.now();
    const now = opts.now ?? new Date();
    const deadline = startedAt + (opts.deadlineMs ?? 8 * 60_000);
    const studio = await this.prisma.studio.findUnique({ where: { id: studioId }, select: { id: true, timezone: true } });
    if (!studio) throw new NotFoundException('Studio not found');
    const ctx: RulesContext = { studioId, now, timeZone: studio.timezone };
    const counters = { stripeCalls: 0, stripeFailures: 0, skipped: 0 };

    // ── Local snapshots (PII-free) ───────────────────────────────────────────────
    const memberRows = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        stripeCustomerId: { not: null },
        // Review/demo accounts are flagged excludeFromAnalytics: their Stripe ids are synthetic.
        studioMemberships: { some: { studioId, deletedAt: null, excludeFromAnalytics: false } },
      },
      select: { id: true, stripeCustomerId: true },
      orderBy: { createdAt: 'asc' },
      take: (opts.maxMembers ?? 5000) + 1,
    });
    const maxMembers = opts.maxMembers ?? 5000;
    if (memberRows.length > maxMembers) {
      counters.skipped += memberRows.length - maxMembers;
      memberRows.length = maxMembers;
    }
    const memberUserIds = memberRows.map((m) => m.id);

    const localRows = await this.prisma.subscription.findMany({
      where: { studioId, source: SubscriptionSource.STRIPE, userId: { in: memberUserIds } },
      select: {
        id: true, userId: true, membershipPlanId: true, exclusiveGroupKey: true, status: true, source: true, stripeSubscriptionId: true,
        endReason: true, supersededBySubscriptionId: true, cancelAtPeriodEnd: true, currentPeriodStart: true, currentPeriodEnd: true,
        entitlementEndsAt: true, updatedAt: true, membershipPlan: { select: { name: true, entitlementDays: true } },
      },
    });
    const locals: LocalSubscriptionSnapshot[] = localRows.map((r) => ({
      id: r.id, userId: r.userId, membershipPlanId: r.membershipPlanId, planName: r.membershipPlan.name, exclusiveGroupKey: r.exclusiveGroupKey,
      isFixedDuration: r.membershipPlan.entitlementDays != null, status: r.status, source: r.source, stripeSubscriptionId: r.stripeSubscriptionId,
      endReason: r.endReason, supersededBySubscriptionId: r.supersededBySubscriptionId, cancelAtPeriodEnd: r.cancelAtPeriodEnd,
      currentPeriodStart: r.currentPeriodStart, currentPeriodEnd: r.currentPeriodEnd, entitlementEndsAt: r.entitlementEndsAt, updatedAt: r.updatedAt,
    }));
    const localStripeIds = new Set(locals.map((l) => l.stripeSubscriptionId).filter((id): id is string => !!id));

    const paymentRows = await this.prisma.payment.findMany({
      where: {
        studioId, paymentMethod: PaymentMethod.STRIPE, userId: { in: memberUserIds },
        status: { in: [PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED] },
        createdAt: { gte: ENTITLEMENT_LEDGER_STARTED_AT },
      },
      select: { id: true, userId: true, subscriptionId: true, membershipPlanId: true, stripeInvoiceId: true, amountCents: true, currency: true, status: true, paidAt: true, createdAt: true },
    });
    const payments: PaymentSnapshot[] = paymentRows;
    const succeededInvoiceIds = new Set(payments.filter((p) => p.status === 'SUCCEEDED' && p.stripeInvoiceId).map((p) => p.stripeInvoiceId!));

    const cycleRows = await this.prisma.membershipEntitlementCycle.findMany({
      where: { studioId },
      select: { id: true, subscriptionId: true, userId: true, membershipPlanId: true, startsAt: true, endsAt: true, stripeInvoiceId: true },
    });
    const cycles: CycleSnapshot[] = cycleRows;

    const planRows = await this.prisma.membershipPlan.findMany({ where: { studioId }, select: { id: true, exclusiveGroup: true } });
    const planGroupById = new Map(planRows.map((p) => [p.id, p.exclusiveGroup]));

    const deletedEvents = await this.loadDeletedEvents(localStripeIds);
    const failedInvoices = await this.loadFailedInvoices(now, localStripeIds);

    // ── Stripe snapshots (GET only, bounded) ───────────────────────────────────
    const members: MemberSnapshot[] = [];
    const stripeSubs: StripeSubscriptionSnapshot[] = [];
    let deadlineHit = false;
    await mapWithConcurrency(memberRows, opts.memberConcurrency ?? 4, async (m) => {
      if (Date.now() > deadline) {
        deadlineHit = true;
        counters.skipped += 1;
        return;
      }
      try {
        const subs = await this.withRetry(() => this.stripe.listSubscriptionsForCustomer(m.stripeCustomerId!, { includeCanceled: true }), counters);
        members.push({ userId: m.id, stripeCustomerId: m.stripeCustomerId!, customerMissingInStripe: false });
        for (const s of subs) stripeSubs.push(this.toStripeSnapshot(s));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/No such customer/i.test(message)) {
          members.push({ userId: m.id, stripeCustomerId: m.stripeCustomerId!, customerMissingInStripe: true });
          return;
        }
        counters.stripeFailures += 1;
        this.logger.warn(JSON.stringify({ event: 'billing_detector_stripe_lookup_failed', studioId, userId: m.id, error: message.slice(0, 200) }));
      }
    });
    const stripeById = new Map(stripeSubs.map((s) => [s.id, s]));
    const membersByUserId = new Map(members.map((m) => [m.userId, m]));

    // Open invoices only where a subscription ended recently (bounded by that set).
    const recentlyEndedCustomers = new Set<string>();
    for (const s of stripeSubs) {
      if ((s.status === 'canceled' || s.status === 'incomplete_expired') && s.canceledAt && now.getTime() - s.canceledAt.getTime() <= 120 * DAY_MS) {
        recentlyEndedCustomers.add(s.customerId);
      }
    }
    for (const l of locals) {
      if (l.status === 'CANCELED' && now.getTime() - l.updatedAt.getTime() <= 120 * DAY_MS) {
        const customer = members.find((m) => m.userId === l.userId)?.stripeCustomerId;
        if (customer) recentlyEndedCustomers.add(customer);
      }
    }
    const openInvoices: OpenInvoiceSnapshot[] = [];
    let openInvoiceFailures = 0;
    await mapWithConcurrency([...recentlyEndedCustomers], opts.memberConcurrency ?? 4, async (customerId) => {
      if (Date.now() > deadline) {
        deadlineHit = true;
        return;
      }
      try {
        const invoices = await this.withRetry(() => this.stripe.listOpenInvoicesForCustomer(customerId), counters);
        for (const inv of invoices) {
          if (!inv.id) continue;
          openInvoices.push({
            id: inv.id,
            customerId,
            stripeSubscriptionId: idOf(inv.parent?.subscription_details?.subscription ?? null) ?? idOf((inv as unknown as { subscription?: string | { id: string } | null }).subscription ?? null),
            amountRemainingCents: inv.amount_remaining ?? 0,
            currency: inv.currency ?? 'mxn',
            createdAt: new Date(inv.created * 1000),
            attemptCount: inv.attempt_count ?? 0,
            nextPaymentAttempt: unixToDate(inv.next_payment_attempt),
            autoAdvance: inv.auto_advance === true,
          });
        }
      } catch (err) {
        openInvoiceFailures += 1;
        this.logger.warn(JSON.stringify({ event: 'billing_detector_open_invoices_failed', studioId, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) }));
      }
    });

    // ── Rules ──────────────────────────────────────────────────────────────────
    const issues: ObservedIssue[] = [];
    issues.push(...detectStripeCanceledLocalAlive(ctx, locals, stripeById, membersByUserId));
    issues.push(...detectLocalCanceledStripeAlive(ctx, locals, stripeById));
    issues.push(...detectIdentityMismatches(ctx, locals, stripeSubs, members, planGroupById));
    issues.push(...detectStalePeriods(ctx, locals, stripeById));
    issues.push(...detectOpenInvoicesOnEndedSubscriptions(ctx, openInvoices, stripeById, locals));
    const endedAtByStripeSubscription = new Map<string, Date>();
    for (const d of deletedEvents) {
      const prev = endedAtByStripeSubscription.get(d.stripeSubscriptionId);
      if (!prev || prev < d.createdAt) endedAtByStripeSubscription.set(d.stripeSubscriptionId, d.createdAt);
    }
    issues.push(...detectMonthlyPaidWithoutEntitlement(ctx, payments, locals, { ledgerStartedAt: ENTITLEMENT_LEDGER_STARTED_AT, endedAtByStripeSubscription }));
    issues.push(...(await this.fixedDurationPaidWithoutCycle(ctx, locals)));
    issues.push(...detectOverlappingCycles(ctx, cycles));
    issues.push(...detectCancellationReasonMismatch(ctx, locals, deletedEvents));
    issues.push(...detectRepeatedPaymentFailures(ctx, locals, failedInvoices, succeededInvoiceIds));

    const stripeComplete = counters.stripeFailures === 0 && !deadlineHit && counters.skipped === 0;
    const coverage: DetectorCoverage[] = [
      ...STRIPE_CATEGORIES.map((category) => ({
        category,
        complete: category === 'OPEN_INVOICE_ON_ENDED_SUBSCRIPTION' ? stripeComplete && openInvoiceFailures === 0 : stripeComplete,
        detail: stripeComplete ? undefined : `stripeFailures=${counters.stripeFailures} skipped=${counters.skipped} deadlineHit=${deadlineHit}`,
      })),
      // Local rules see every row only when no member was dropped by the cap.
      ...LOCAL_CATEGORIES.map((category) => ({ category, complete: counters.skipped === 0, detail: counters.skipped === 0 ? undefined : `skipped=${counters.skipped}` })),
    ];

    const result: StudioDetectionResult = {
      studioId,
      issues,
      coverage,
      checkedMembers: members.length,
      skippedMembers: counters.skipped,
      stripeCalls: counters.stripeCalls,
      stripeFailures: counters.stripeFailures,
      durationMs: Date.now() - startedAt,
    };
    this.logger.log(JSON.stringify({ event: 'billing_detection_completed', studioId, issues: issues.length, checkedMembers: members.length, stripeCalls: counters.stripeCalls, stripeFailures: counters.stripeFailures, skipped: counters.skipped, durationMs: result.durationMs }));
    return result;
  }

  /** Dead-lettered and stuck webhook events, attributed to a studio when the payload names one. */
  async detectWebhookProblems(opts: { now?: Date; minAgeMs?: number } = {}): Promise<{ issues: ObservedIssue[]; complete: boolean }> {
    const now = opts.now ?? new Date();
    const rows = await this.prisma.stripeWebhookEvent.findMany({
      where: { processed: false, resolvedAt: null, createdAt: { lt: new Date(now.getTime() - (opts.minAgeMs ?? 30 * 60_000)) } },
      select: { stripeEventId: true, eventType: true, createdAt: true, attemptCount: true, lastError: true, payload: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const events: StoredEventSnapshot[] = rows.map((r) => ({
      stripeEventId: r.stripeEventId, eventType: r.eventType, createdAt: r.createdAt, attemptCount: r.attemptCount, lastError: r.lastError,
      studioId: readStudioIdFromPayload(r.payload),
    }));
    return { issues: detectWebhookProblems({ studioId: null, now, timeZone: 'America/Mexico_City' }, events, { minAgeMs: 0 }), complete: rows.length < 200 };
  }

  /**
   * Refunds and disputes Stripe recorded in the window, mapped to local Payments (one bounded
   * account-wide list each; a charge retrieve only when the Payment lacks a PaymentIntent id).
   */
  async detectRefundsAndDisputes(opts: { now?: Date; windowDays?: number; studioId?: string | null } = {}): Promise<{ issues: ObservedIssue[]; complete: boolean; stripeCalls: number }> {
    const now = opts.now ?? new Date();
    const since = Math.floor((now.getTime() - (opts.windowDays ?? 45) * DAY_MS) / 1000);
    const counters = { stripeCalls: 0, stripeFailures: 0, skipped: 0 };
    const issues: ObservedIssue[] = [];
    let complete = true;
    const timeZone = 'America/Mexico_City';

    const resolvePayment = async (paymentIntent: string | { id: string } | null | undefined, charge: string | { id: string } | null | undefined) => {
      const select = { id: true, studioId: true, userId: true, subscriptionId: true, amountCents: true, currency: true, status: true, stripeInvoiceId: true } as const;
      let piId = idOf(paymentIntent ?? null);
      const chargeId = idOf(charge ?? null);
      if (!piId && chargeId) {
        try {
          const ch = await this.withRetry(() => this.stripe.retrieveCharge(chargeId), counters);
          piId = idOf(ch.payment_intent as string | { id: string } | null);
        } catch {
          complete = false;
        }
      }
      if (!piId) return null;
      const byPi = await this.prisma.payment.findUnique({ where: { stripePaymentIntentId: piId }, select });
      if (byPi) return byPi;
      // Basil-and-later: the invoice is reached through the InvoicePayment resource, not the charge.
      try {
        const invoiceId = await this.withRetry(() => this.stripe.findInvoiceIdForPaymentIntent(piId!), counters);
        if (invoiceId) return this.prisma.payment.findUnique({ where: { stripeInvoiceId: invoiceId }, select });
      } catch {
        complete = false;
      }
      return null;
    };

    try {
      const refunds = await this.withRetry(() => this.stripe.listRefundsSince(since), counters);
      if (refunds.hasMore) complete = false;
      for (const refund of refunds.data) {
        const payment = await resolvePayment(refund.payment_intent, refund.charge);
        if (!payment || (opts.studioId && payment.studioId !== opts.studioId)) continue;
        const amount = refund.amount ?? 0;
        const currency = (refund.currency ?? payment.currency).toLowerCase();
        issues.push({
          studioId: payment.studioId,
          category: 'PAYMENT_REFUNDED_OR_DISPUTED',
          severity: 'MEDIUM',
          reasonCode: amount >= payment.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          // Same key the charge.refunded handler uses, so the webhook and the scan share one case.
          issueRef: idOf(refund.charge ?? null) ?? refund.id,
          userId: payment.userId,
          subscriptionId: payment.subscriptionId,
          paymentId: payment.id,
          stripeInvoiceId: payment.stripeInvoiceId,
          title: `Reembolso en Stripe: ${formatMoney(amount, currency)}`,
          summary: `Stripe reembolsó ${formatMoney(amount, currency)} el ${formatDateEs(new Date(refund.created * 1000), timeZone)} de un pago de ${formatMoney(payment.amountCents, payment.currency)}. GymOS no retiró el acceso automáticamente.`,
          suggestedAction: 'Revisa si la vigencia pagada debe terminar antes o cancelarse; si fue un cobro duplicado, no se requiere más acción.',
          evidence: { refundId: refund.id, amountCents: amount, currency, status: refund.status, reason: refund.reason ?? null, localPaymentStatus: payment.status, stripeInvoiceId: payment.stripeInvoiceId },
        });
      }
    } catch (err) {
      complete = false;
      this.logger.warn(JSON.stringify({ event: 'billing_detector_refunds_failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 200) }));
    }

    try {
      const disputes = await this.withRetry(() => this.stripe.listDisputesSince(since), counters);
      if (disputes.hasMore) complete = false;
      for (const dispute of disputes.data) {
        const payment = await resolvePayment(dispute.payment_intent, dispute.charge);
        if (!payment || (opts.studioId && payment.studioId !== opts.studioId)) continue;
        const currency = (dispute.currency ?? payment.currency).toLowerCase();
        issues.push({
          studioId: payment.studioId,
          category: 'PAYMENT_REFUNDED_OR_DISPUTED',
          severity: 'HIGH',
          reasonCode: 'DISPUTED',
          issueRef: dispute.id,
          userId: payment.userId,
          subscriptionId: payment.subscriptionId,
          paymentId: payment.id,
          stripeInvoiceId: payment.stripeInvoiceId,
          title: `Disputa de pago en Stripe: ${formatMoney(dispute.amount, currency)}`,
          summary: `El miembro disputó un cobro el ${formatDateEs(new Date(dispute.created * 1000), timeZone)} (${dispute.reason}; estado ${dispute.status}). GymOS no cambió el acceso.`,
          suggestedAction: 'Responde la disputa en Stripe y decide si la membresía debe seguir vigente mientras se resuelve.',
          evidence: { disputeId: dispute.id, amountCents: dispute.amount, currency, reason: dispute.reason, status: dispute.status, stripeInvoiceId: payment.stripeInvoiceId },
        });
      }
    } catch (err) {
      complete = false;
      this.logger.warn(JSON.stringify({ event: 'billing_detector_disputes_failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 200) }));
    }
    return { issues, complete, stripeCalls: counters.stripeCalls };
  }

  // ── helpers ───────────────────────────────────────────────────────────────────

  private toStripeSnapshot(s: Stripe.Subscription): StripeSubscriptionSnapshot {
    const item = s.items?.data?.[0];
    return {
      id: s.id,
      customerId: idOf(s.customer as string | { id: string }) ?? '',
      status: s.status,
      cancelAtPeriodEnd: s.cancel_at_period_end === true,
      canceledAt: unixToDate(s.canceled_at),
      cancellationReason: s.cancellation_details?.reason ?? null,
      currentPeriodEnd: unixToDate((item as unknown as { current_period_end?: number } | undefined)?.current_period_end ?? (s as unknown as { current_period_end?: number }).current_period_end),
      metadataStudioId: s.metadata?.['studioId'] ?? null,
      metadataUserId: s.metadata?.['userId'] ?? null,
      metadataPlanId: s.metadata?.['planId'] ?? null,
      priceId: item?.price?.id ?? null,
      latestInvoiceId: idOf(s.latest_invoice as string | { id: string } | null),
    };
  }

  private async withRetry<T>(fn: () => Promise<T>, counters: { stripeCalls: number }, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      counters.stripeCalls += 1;
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const type = (err as { type?: string } | null)?.type;
        const status = (err as { statusCode?: number } | null)?.statusCode;
        const retryable = type === 'StripeRateLimitError' || type === 'StripeConnectionError' || status === 429 || (typeof status === 'number' && status >= 500);
        if (!retryable || attempt === attempts - 1) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  private async fixedDurationPaidWithoutCycle(ctx: RulesContext, locals: LocalSubscriptionSnapshot[]): Promise<ObservedIssue[]> {
    const gaps = await loadPaidWithoutEntitlement(this.prisma, { studioId: ctx.studioId });
    const localById = new Map(locals.map((l) => [l.id, l]));
    return gaps.map((gap) => {
      const row = gap.subscriptionId ? localById.get(gap.subscriptionId) : undefined;
      // A superseded row was deliberately NOT granted (late-payment policy E): resending the
      // event cannot fix it, an operator decision can.
      const superseded = !!row && (row.supersededBySubscriptionId !== null || (row.endReason !== null && ['SUPERSEDED_PAYMENT_METHOD', 'SUPERSEDED_RENEWAL', 'SUPERSEDED_PLAN_CHANGE'].includes(row.endReason)));
      return {
        studioId: ctx.studioId,
        category: 'PAID_WITHOUT_ENTITLEMENT' as const,
        severity: 'CRITICAL' as const,
        reasonCode: superseded ? 'SUPERSEDED_MEMBERSHIP' : 'FIXED_DURATION_NO_CYCLE',
        issueRef: gap.stripeInvoiceId,
        userId: gap.userId,
        subscriptionId: gap.subscriptionId,
        paymentId: gap.paymentId,
        stripeInvoiceId: gap.stripeInvoiceId,
        stripeSubscriptionId: row?.stripeSubscriptionId ?? null,
        title: `Pago recibido sin acceso: ${formatMoney(gap.amountCents, gap.currency)}${row ? ` de ${row.planName}` : ''}`,
        summary: superseded
          ? `Stripe cobró la factura ${gap.stripeInvoiceId} (${formatDateEs(gap.paidAt, ctx.timeZone)}) de una membresía que GymOS ya reemplazó por otra; el cobro no otorgó vigencia.`
          : `Stripe cobró la renovación (factura ${gap.stripeInvoiceId}, ${formatDateEs(gap.paidAt, ctx.timeZone)}), pero no se generó la vigencia correspondiente.`,
        suggestedAction: superseded
          ? 'Decide con el miembro: reembolsa en Stripe o extiende manualmente la membresía vigente. No reactives la suscripción reemplazada.'
          : 'Reenvía el invoice.paid desde Stripe para que GymOS genere la vigencia; si no procede, marca el evento como resuelto con una nota.',
        evidence: { amountCents: gap.amountCents, currency: gap.currency, paidAt: gap.paidAt.toISOString(), entitlementGranted: false, whyNotGranted: superseded ? 'SUPERSEDED_MEMBERSHIP' : 'FIXED_DURATION_NO_CYCLE', localStatus: row?.status ?? null, localEndReason: row?.endReason ?? null },
      };
    });
  }

  private async loadDeletedEvents(localStripeIds: Set<string>): Promise<DeletedEventSnapshot[]> {
    const rows = await this.prisma.stripeWebhookEvent.findMany({
      where: { eventType: 'customer.subscription.deleted' },
      select: { stripeEventId: true, createdAt: true, payload: true },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });
    const out: DeletedEventSnapshot[] = [];
    for (const r of rows) {
      const subId = readPath(r.payload, ['data', 'object', 'id']);
      if (typeof subId !== 'string' || !localStripeIds.has(subId)) continue;
      const status = readPath(r.payload, ['data', 'object', 'status']);
      const reason = readPath(r.payload, ['data', 'object', 'cancellation_details', 'reason']);
      out.push({ stripeEventId: r.stripeEventId, stripeSubscriptionId: subId, status: typeof status === 'string' ? status : 'canceled', cancellationReason: typeof reason === 'string' ? reason : null, createdAt: r.createdAt });
    }
    return out;
  }

  private async loadFailedInvoices(now: Date, localStripeIds: Set<string>): Promise<FailedInvoiceSnapshot[]> {
    const rows = await this.prisma.stripeWebhookEvent.findMany({
      where: { eventType: 'invoice.payment_failed', createdAt: { gte: new Date(now.getTime() - 45 * DAY_MS) } },
      select: { createdAt: true, payload: true },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    });
    const byInvoice = new Map<string, FailedInvoiceSnapshot>();
    for (const r of rows) {
      const invoiceId = readPath(r.payload, ['data', 'object', 'id']);
      if (typeof invoiceId !== 'string') continue;
      const subId = readPath(r.payload, ['data', 'object', 'parent', 'subscription_details', 'subscription']) ?? readPath(r.payload, ['data', 'object', 'subscription']);
      const stripeSubscriptionId = typeof subId === 'string' ? subId : null;
      if (stripeSubscriptionId && !localStripeIds.has(stripeSubscriptionId)) continue;
      const attemptCount = readPath(r.payload, ['data', 'object', 'attempt_count']);
      const next = readPath(r.payload, ['data', 'object', 'next_payment_attempt']);
      const prev = byInvoice.get(invoiceId);
      const attempts = Math.max(prev?.attempts ?? 0, typeof attemptCount === 'number' ? attemptCount : (prev?.attempts ?? 0) + 1);
      byInvoice.set(invoiceId, { stripeInvoiceId: invoiceId, stripeSubscriptionId, attempts, lastAttemptAt: r.createdAt, nextPaymentAttempt: unixToDate(typeof next === 'number' ? next : null) });
    }
    return [...byInvoice.values()];
  }
}
