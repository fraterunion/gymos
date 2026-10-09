import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaymentStatus, Prisma, SubscriptionSource } from '@prisma/client';
import { loadPaidWithoutEntitlement } from '../billing/paid-without-entitlement';
import {
  STRIPE_RENEWAL_AUDIT_ACTIONS,
  STRIPE_TO_CASH_IMMEDIATE,
  STRIPE_TO_CASH_PERIOD_END_SCHEDULED,
} from '../billing/stripe-renewal-audit.constants';
import { deriveMembershipLifecycle } from '../memberships/membership-entitlement';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { BillingCaseService } from '../billing/reconciliation/billing-case.service';
import {
  buildPaymentFailureView,
  explainMembershipBilling,
  readCancellationFeedbackNear,
  readStoredInvoiceFailure,
  readStripeRenewalFlip,
  readStripeSubscriptionEndings,
  readStripeSubscriptionFacts,
  resolveRenewalChange,
  type FailedInvoiceFacts,
  type LiveInvoiceFailure,
  type MembershipBillingStatus,
  type PaymentFailureView,
  type RenewalAuditFact,
  type StoredStripeEvent,
  type SubscriptionEndOrigin,
  type RenewalChangeOrigin,
} from './membership-billing-status';

export type MemberBillingCaseView = {
  id: string;
  category: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  status: 'OPEN' | 'ACKNOWLEDGED';
  reasonCode: string | null;
  title: string;
  summary: string;
  suggestedAction: string;
  subscriptionId: string | null;
  stripeInvoiceId: string | null;
  firstDetectedAt: string;
  lastObservedAt: string;
  acknowledgedAt: string | null;
};

export type MemberBillingStatusResponse = {
  generatedAt: string;
  /** One explanation per subscription of the member, newest first. */
  memberships: MembershipBillingStatus[];
  /** FAILED payments, newest first, with the decline reason when it could be read. */
  failedPayments: PaymentFailureView[];
  /** Open/acknowledged reconciliation cases for this member — never "Al corriente" while one is critical. */
  openCases: MemberBillingCaseView[];
};

export type SubscriptionEndingView = {
  subscriptionId: string | null;
  planName: string | null;
  at: Date;
  cancellationReason: string | null;
  feedback: string | null;
  origin: SubscriptionEndOrigin;
  scheduledBy: RenewalChangeOrigin | null;
  /** The failed charge behind a cancellation for non-payment (within 60 days before it). */
  failure: PaymentFailureView | null;
};

export type MemberBillingContext = MemberBillingStatusResponse & {
  /** Stored customer.subscription.* events for the member's card subscriptions. */
  subscriptionEvents: StoredStripeEvent[];
  /** Subscriptions Stripe ended, with who/why. */
  subscriptionEndings: SubscriptionEndingView[];
};

/** Live Stripe lookups per request: newest failures first; older ones say "not checked". */
const MAX_LIVE_LOOKUPS = 5;
const LIVE_LOOKUP_DEADLINE_MS = 4_000;
const LIVE_CACHE_TTL_MS = 2 * 60_000;
const LIVE_CACHE_ERROR_TTL_MS = 30_000;
const LIVE_CACHE_MAX_ENTRIES = 500;
const STORED_EVENTS_CAP = 500;
const FAILURE_BEFORE_ENDING_WINDOW_MS = 60 * 86_400_000;
const RENEWAL_HISTORY_ACTIONS = [...STRIPE_RENEWAL_AUDIT_ACTIONS, STRIPE_TO_CASH_PERIOD_END_SCHEDULED, STRIPE_TO_CASH_IMMEDIATE];
const STRIPE_TO_CASH_ACTIONS: string[] = [STRIPE_TO_CASH_PERIOD_END_SCHEDULED, STRIPE_TO_CASH_IMMEDIATE];
/** Statuses that mean the member paid for the invoice (a refund does not reopen a failure). */
const PAID_STATUSES: PaymentStatus[] = [PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED];

type LiveLookupResult = { ok: true; value: LiveInvoiceFailure } | { ok: false };

/**
 * Staff-only billing explanations for Member 360. Reads local rows, the AuditLog and stored Stripe
 * webhook payloads, plus a bounded, cached, read-only Stripe lookup for decline reasons. Writes
 * nothing anywhere. Not used by the member-facing profile (`/members/me`), so decline codes and
 * Stripe risk outcomes never reach the member app.
 */
@Injectable()
export class MemberBillingStatusService {
  private readonly logger = new Logger(MemberBillingStatusService.name);
  private readonly liveCache = new Map<string, { expiresAt: number; result: LiveLookupResult }>();
  private readonly inFlight = new Map<string, Promise<LiveLookupResult>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly billingCases: BillingCaseService,
  ) {}

  async getMemberBillingStatus(studioId: string, userId: string, now = new Date()): Promise<MemberBillingStatusResponse> {
    const { generatedAt, memberships, failedPayments, openCases } = await this.loadBillingContext(studioId, userId, now);
    return { generatedAt, memberships, failedPayments, openCases };
  }

  async loadBillingContext(studioId: string, userId: string, now = new Date()): Promise<MemberBillingContext> {
    const member = await this.prisma.studioMembership.findFirst({ where: { studioId, userId, deletedAt: null }, select: { id: true } });
    if (!member) throw new NotFoundException('Member not found');

    const [subscriptions, payments, audits] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { studioId, userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          source: true,
          stripeSubscriptionId: true,
          cancelAtPeriodEnd: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          entitlementEndsAt: true,
          endReason: true,
          createdAt: true,
          membershipPlan: { select: { name: true, entitlementDays: true } },
        },
      }),
      this.prisma.payment.findMany({
        where: { studioId, userId, status: { in: [PaymentStatus.FAILED, ...PAID_STATUSES] } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, subscriptionId: true, status: true, amountCents: true, currency: true, stripeInvoiceId: true, createdAt: true, paidAt: true },
      }),
      this.prisma.auditLog.findMany({
        where: { studioId, targetUserId: userId, action: { in: RENEWAL_HISTORY_ACTIONS } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { action: true, createdAt: true, entityId: true, metadata: true, actor: { select: { firstName: true, lastName: true } } },
      }),
    ]);

    const stripeSubscriptionIds = new Map<string, string>();
    for (const s of subscriptions) {
      if (s.source === SubscriptionSource.STRIPE && s.stripeSubscriptionId) stripeSubscriptionIds.set(s.id, s.stripeSubscriptionId);
    }

    const failedRows = payments.filter((p) => p.status === PaymentStatus.FAILED && p.stripeInvoiceId);

    // Live lookups for the newest failures (bounded); runs alongside the stored-event reads.
    const livePromise = this.lookupLive(`${studioId}:${userId}`, failedRows.slice(0, MAX_LIVE_LOOKUPS).map((p) => p.stripeInvoiceId as string));
    const [subscriptionEvents, invoiceEvents, paidWithoutEntitlement, liveResults] = await Promise.all([
      this.loadStoredEvents('customer.subscription.', [...stripeSubscriptionIds.values()]),
      this.loadStoredEvents('invoice.payment_failed', failedRows.map((p) => p.stripeInvoiceId as string)),
      subscriptions.some((s) => s.source === SubscriptionSource.STRIPE && s.membershipPlan.entitlementDays !== null)
        ? loadPaidWithoutEntitlement(this.prisma, { studioId, userId })
        : Promise.resolve([]),
      livePromise,
    ]);

    const failureFacts = (p: (typeof failedRows)[number]): FailedInvoiceFacts => {
      const invoiceId = p.stripeInvoiceId as string;
      const live = liveResults.get(invoiceId);
      return {
        paymentId: p.id,
        invoiceId,
        amountCents: p.amountCents,
        currency: p.currency,
        firstFailedAt: p.createdAt,
        stored: readStoredInvoiceFailure(invoiceEvents, invoiceId),
        live: live?.ok ? live.value : null,
        liveLookup: live === undefined ? 'skipped' : live.ok ? 'ok' : 'unavailable',
      };
    };
    const failureViews = new Map(failedRows.map((p) => [p.id, buildPaymentFailureView(failureFacts(p))]));

    // A failure is current while its own invoice is still collectible. Stripe's invoice status
    // decides when we have it; without it, a later paid invoice on the subscription is taken as
    // the failure being behind the member.
    const currentFailureBySubscription = new Map<string, (typeof failedRows)[number]>();
    for (const s of subscriptions) {
      for (const p of failedRows.filter((row) => row.subscriptionId === s.id)) {
        const view = failureViews.get(p.id);
        const status = view?.invoiceStatus ?? null;
        const knownFromStripe = view?.detailSource === 'stripe_live';
        if (knownFromStripe && (status === 'void' || status === 'paid')) continue;
        if (!knownFromStripe) {
          const paidAfter = payments.some(
            (q) => q.subscriptionId === s.id && PAID_STATUSES.includes(q.status) && (q.paidAt ?? q.createdAt).getTime() > p.createdAt.getTime(),
          );
          if (paidAfter) continue;
        }
        currentFailureBySubscription.set(s.id, p);
        break;
      }
    }

    // Audit rows per local subscription. A Stripe→cash audit belongs to the card subscription it
    // stopped (oldSubscriptionId), not to the cash row it created (entityId).
    const auditFacts = audits.map((a) => {
      const md = readMetadata(a.metadata);
      const role = typeof md['actorRole'] === 'string' && md['actorRole'] ? ` · ${md['actorRole']}` : '';
      const subscriptionId = STRIPE_TO_CASH_ACTIONS.includes(a.action)
        ? (typeof md['oldSubscriptionId'] === 'string' ? md['oldSubscriptionId'] : null)
        : typeof md['subscriptionId'] === 'string' ? md['subscriptionId'] : a.entityId;
      const fact: RenewalAuditFact = { action: a.action, at: a.createdAt, actorName: a.actor ? `${a.actor.firstName} ${a.actor.lastName}${role}` : null, metadata: md };
      return { subscriptionId, stripeSubscriptionId: typeof md['stripeSubscriptionId'] === 'string' ? md['stripeSubscriptionId'] : null, fact };
    });
    const auditsFor = (subscriptionId: string) => auditFacts.filter((a) => a.subscriptionId === subscriptionId).map((a) => a.fact);

    const memberships = subscriptions.map((s) => {
      const lifecycle = deriveMembershipLifecycle(s, now);
      const stripeSubId = stripeSubscriptionIds.get(s.id) ?? null;
      const stripeFacts = stripeSubId ? readStripeSubscriptionFacts(subscriptionEvents, stripeSubId) : null;
      const flip = stripeSubId ? readStripeRenewalFlip(subscriptionEvents, stripeSubId) : null;
      const feedback = stripeSubId && flip?.disabled ? readCancellationFeedbackNear(subscriptionEvents, stripeSubId, flip.at) : null;
      const failure = currentFailureBySubscription.get(s.id);
      return explainMembershipBilling({
        local: {
          subscriptionId: s.id,
          planName: s.membershipPlan.name,
          source: s.source,
          status: s.status,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          currentPeriodEnd: s.currentPeriodEnd,
          endReason: s.endReason,
          isEntitled: lifecycle.isEntitled,
          lifecycleStatus: lifecycle.lifecycleStatus,
          effectiveEnd: lifecycle.effectiveEnd,
          fixedTerm: s.membershipPlan.entitlementDays !== null,
          paidWithoutEntitlement: paidWithoutEntitlement.some((g) => g.subscriptionId === s.id),
        },
        stripe: stripeFacts,
        renewalChange: s.source === SubscriptionSource.STRIPE ? resolveRenewalChange({ flip, feedback, audits: auditsFor(s.id) }) : null,
        failure: failure ? failureFacts(failure) : null,
        now,
      });
    });

    const auditsByStripeSubscription = new Map<string, RenewalAuditFact[]>();
    for (const a of auditFacts) {
      if (!a.stripeSubscriptionId) continue;
      auditsByStripeSubscription.set(a.stripeSubscriptionId, [...(auditsByStripeSubscription.get(a.stripeSubscriptionId) ?? []), a.fact]);
    }
    const localByStripeId = new Map([...stripeSubscriptionIds].map(([localId, stripeId]) => [stripeId, localId]));
    const subscriptionEndings = readStripeSubscriptionEndings(subscriptionEvents, auditsByStripeSubscription).map((ending): SubscriptionEndingView => {
      const subscriptionId = localByStripeId.get(ending.stripeSubscriptionId) ?? null;
      const planName = subscriptions.find((s) => s.id === subscriptionId)?.membershipPlan.name ?? null;
      const failureRow =
        ending.cancellationReason === 'payment_failed'
          ? failedRows.find(
              (p) =>
                p.subscriptionId === subscriptionId &&
                p.createdAt.getTime() <= ending.at.getTime() &&
                ending.at.getTime() - p.createdAt.getTime() <= FAILURE_BEFORE_ENDING_WINDOW_MS,
            )
          : undefined;
      return { subscriptionId, planName, ...ending, failure: failureRow ? failureViews.get(failureRow.id) ?? null : null };
    });

    const openCaseRows = await this.billingCases.openCasesForMember(this.prisma, studioId, userId);
    const openCases: MemberBillingCaseView[] = openCaseRows.map((c) => ({
      id: c.id,
      category: c.category,
      severity: c.severity,
      status: c.status as 'OPEN' | 'ACKNOWLEDGED',
      reasonCode: c.reasonCode,
      title: c.title,
      summary: c.summary,
      suggestedAction: c.suggestedAction,
      subscriptionId: c.subscriptionId,
      stripeInvoiceId: c.stripeInvoiceId,
      firstDetectedAt: c.firstDetectedAt.toISOString(),
      lastObservedAt: c.lastObservedAt.toISOString(),
      acknowledgedAt: c.acknowledgedAt?.toISOString() ?? null,
    }));

    return {
      generatedAt: now.toISOString(),
      memberships,
      failedPayments: failedRows.slice(0, 20).map((p) => failureViews.get(p.id) as PaymentFailureView),
      openCases,
      subscriptionEvents,
      subscriptionEndings,
    };
  }

  /**
   * Stored Stripe events whose data.object.id is one of `ids`, newest first (capped). No date bound:
   * local rows can be linked to a Stripe subscription long after its first events (re-linked or
   * migrated rows). The table holds full payloads; only fields are read.
   */
  private async loadStoredEvents(eventTypePrefix: string, ids: readonly string[]): Promise<StoredStripeEvent[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const where: Prisma.StripeWebhookEventWhereInput = {
      ...(eventTypePrefix.endsWith('.') ? { eventType: { startsWith: eventTypePrefix } } : { eventType: eventTypePrefix }),
      OR: unique.map((id) => ({ payload: { path: ['data', 'object', 'id'], equals: id } })),
    };
    const rows = await this.prisma.stripeWebhookEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: STORED_EVENTS_CAP, select: { eventType: true, createdAt: true, payload: true } });
    if (rows.length === STORED_EVENTS_CAP) {
      this.logger.warn({ event: 'member_billing_status_stored_events_capped', eventTypePrefix, cap: STORED_EVENTS_CAP });
    }
    return rows.map((r) => ({ eventType: r.eventType, createdAt: r.createdAt, payload: r.payload }));
  }

  /**
   * `scope` is "studioId:userId". Invoice ids reach this method only from the member's own
   * studio-scoped rows, and cache entries are keyed by that scope too, so an entry can never be
   * served to another studio or member (defence in depth: invoice ids are also globally unique).
   */
  private async lookupLive(scope: string, invoiceIds: readonly string[]): Promise<Map<string, LiveLookupResult>> {
    const results = new Map<string, LiveLookupResult>();
    await Promise.all(
      [...new Set(invoiceIds)].map(async (invoiceId) => {
        results.set(invoiceId, await this.lookupOne(`${scope}:${invoiceId}`, invoiceId));
      }),
    );
    return results;
  }

  /** Cached, de-duplicated (concurrent requests share one Stripe call), deadline-bounded lookup. */
  private lookupOne(cacheKey: string, invoiceId: string): Promise<LiveLookupResult> {
    const cached = this.liveCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const run = (async (): Promise<LiveLookupResult> => {
      let result: LiveLookupResult;
      let timer: NodeJS.Timeout | undefined;
      try {
        const value = await Promise.race([
          this.stripe.getInvoicePaymentFailureSnapshot(invoiceId),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('deadline exceeded')), LIVE_LOOKUP_DEADLINE_MS);
          }),
        ]);
        result = { ok: true, value };
      } catch (err) {
        this.logger.warn({ event: 'member_billing_status_stripe_lookup_failed', stripeInvoiceId: invoiceId, error: err instanceof Error ? err.message : String(err) });
        result = { ok: false };
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (this.liveCache.size >= LIVE_CACHE_MAX_ENTRIES) {
        const oldest = this.liveCache.keys().next().value;
        if (oldest !== undefined) this.liveCache.delete(oldest);
      }
      this.liveCache.set(cacheKey, { expiresAt: Date.now() + (result.ok ? LIVE_CACHE_TTL_MS : LIVE_CACHE_ERROR_TTL_MS), result });
      return result;
    })();
    this.inFlight.set(cacheKey, run);
    void run.finally(() => this.inFlight.delete(cacheKey));
    return run;
  }
}

function readMetadata(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
