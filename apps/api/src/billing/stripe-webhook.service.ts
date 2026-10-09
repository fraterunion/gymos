import { Injectable, Logger } from '@nestjs/common';
import { DayPassStatus, MembershipPlan, PaymentMethod, PaymentStatus, Prisma, Subscription, SubscriptionEndReason, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { StripeToCashTransitionService } from './stripe-to-cash-transition.service';
import { StripeRenewalAuditService } from './stripe-renewal-audit.service';
import { buildPaidFixedEntitlementCycle, planPaidCycleInsertion } from './fixed-entitlement-cycle';
import {
  classifyFixedDurationInvoice,
  FixedDurationEntitlementError,
  type FixedDurationDecision,
  type InvoiceLineDiagnostic,
} from './fixed-duration-invoice';
import { RENEWABLE_SUBSCRIPTION_STATUSES } from './subscription-lifecycle.constants';
import { acquireSubscriptionWriteAdvisoryLock } from './subscription-write-advisory-lock';
import {
  readCurrentStripePriceId,
  readPendingPlanIdFromMetadata,
} from './subscription-plan-resolution.utils';
import { markStripeWebhookEventProcessed, tryClaimStripeWebhookEvent } from './stripe-webhook-idempotency';
import { BillingCaseService } from './reconciliation/billing-case.service';
import type { ObservedIssue } from './reconciliation/billing-case.types';
import { formatDateEs, formatMoney } from './reconciliation/billing-case-copy';
import { decidePaidInvoice, type PaidInvoiceDecision } from './paid-invoice-policy';
import {
  ConcurrentSubscriptionWriteError,
  StaleSubscriptionEventUnverifiedError,
  isTerminalStripeStatus,
  judgeTerminalConflict,
  needsLiveVerification,
  type LiveSubscriptionLookup,
} from './stale-subscription-event';
import { resolveStripeEndReason } from './subscription-end-reason';
import type { WebhookChargePayload, WebhookDisputePayload } from './stripe-webhook-payloads';
import {
  type WebhookCheckoutSessionPayload,
  type WebhookInvoicePayload,
  type WebhookPaymentIntentPayload,
  type WebhookSubscriptionPayload,
} from './stripe-webhook-payloads';
import { mapStripeSubscriptionStatus } from './stripe-subscription-status';
import {
  findConflictingMemberships,
  findCreationConflicts,
} from '../memberships/membership-compatibility';
import { readInvoiceSubscriptionId } from './stripe-invoice.utils';
import { parseInvoiceLines } from './stripe-invoice-lines';
import { readCancellationDetails } from './stripe-renewal-audit.utils';
import { activateDayPassFromSucceededPaymentIntent } from '../day-passes/day-pass-activation';
import { logDayPassEvent } from '../day-passes/day-pass-events';

type VerifiedStripeEvent = {
  id: string;
  type: string;
  data: { object: unknown };
  request?: { id: string | null; idempotency_key?: string | null } | null;
  created?: number;
};

type SubscriptionEventContext = {
  eventId: string;
  eventType: string;
  requestId: string | null;
  idempotencyKey: string | null;
  receivedAt: Date;
};

type InvoiceContext = {
  userId: string;
  studioId: string;
  dbSubscriptionId: string | null;
  membershipPlanId: string | null;
};

type FixedDurationSubscription = Subscription & { membershipPlan: MembershipPlan };

/** Request-path Stripe GETs (terminal-conflict guard, late-payment policy) must fail fast. */
const LIVE_LOOKUP_TIMEOUT_MS = 4_000;

const CYCLE_SELECT = {
  id: true,
  subscriptionId: true,
  startsAt: true,
  endsAt: true,
  stripeInvoiceId: true,
} as const;

function eventToJsonPayload(event: VerifiedStripeEvent): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;
}

/**
 * Safely converts a Stripe period timestamp to a Date.
 * Returns null for: null, undefined, 0, negative numbers, non-finite numbers,
 * and unparseable strings.
 */
function parseStripePeriodDate(value: number | string | null | undefined): Date | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(value * 1000);
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function readTriplet(md: Record<string, string> | null | undefined): {
  userId?: string;
  studioId?: string;
  planId?: string;
} {
  if (!md) {
    return {};
  }
  return {
    userId: md['userId'] ?? undefined,
    studioId: md['studioId'] ?? undefined,
    planId: md['planId'] ?? undefined,
  };
}

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly enrollment: EnrollmentService,
    private readonly subscriptionLifecycle: SubscriptionLifecycleService,
    private readonly stripeToCash: StripeToCashTransitionService,
    private readonly stripeRenewalAudit: StripeRenewalAuditService,
    private readonly billingCases: BillingCaseService,
  ) {}

  /**
   * Kill switch for the out-of-order subscription-event guard (`BILLING_STALE_EVENT_GUARD=off`
   * restores the pre-guard upsert without a deploy). Default: on.
   */
  private staleEventGuardEnabled(): boolean {
    return process.env['BILLING_STALE_EVENT_GUARD'] !== 'off';
  }

  /** GET-only: Stripe's current view of a subscription, for terminal-conflict decisions. */
  private async lookupLiveSubscription(stripeSubscriptionId: string): Promise<LiveSubscriptionLookup> {
    try {
      const live = await this.stripe.retrieveSubscription(stripeSubscriptionId, { timeoutMs: LIVE_LOOKUP_TIMEOUT_MS });
      return { ok: true, status: live.status, cancellationReason: live.cancellation_details?.reason ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string } | null)?.code;
      // A subscription Stripe no longer knows is, for ordering purposes, terminal.
      if (code === 'resource_missing' || /No such subscription/i.test(message)) return { ok: true, status: 'canceled', cancellationReason: null };
      return { ok: false, error: message };
    }
  }

  async handleIncomingWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const event = this.stripe.constructWebhookEvent(rawBody, signature) as VerifiedStripeEvent;
    const shouldProcess = await tryClaimStripeWebhookEvent(this.prisma, {
      id: event.id,
      type: event.type,
      payload: eventToJsonPayload(event),
    });
    if (!shouldProcess) {
      return;
    }
    try {
      await this.dispatch(event);
    } catch (err) {
      this.logger.error(`Stripe webhook handler failed for ${event.type} ${event.id}`, err);
      // Persist the error message so dead-letter detection has a human-readable cause.
      // Slice to 500 chars to avoid unbounded column growth on noisy stack traces.
      const lastError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await this.prisma.stripeWebhookEvent.updateMany({
        where: { stripeEventId: event.id, processed: false },
        data: { lastError },
      });
      // Re-throw: event stays processed=false, resolvedAt=null → actionable dead letter.
      // An operator must inspect and either replay or set resolvedAt.
      throw err;
    }
    // processed=true means the handler ran to completion — including deliberate
    // business-logic acknowledgments (e.g. handleWebhookActiveConflict Cases B and C).
    // It is NOT the same as resolvedAt: that field covers historical handler failures
    // where the underlying state was reconciled externally without the handler running.
    await markStripeWebhookEventProcessed(this.prisma, event.id);
  }

  private async dispatch(event: VerifiedStripeEvent): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed':
        await this.onCheckoutSessionCompleted(event.data.object as WebhookCheckoutSessionPayload);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.onCustomerSubscription(
          event.data.object as WebhookSubscriptionPayload,
          {
            eventId: event.id,
            eventType: event.type,
            requestId: event.request?.id ?? null,
            idempotencyKey: event.request?.idempotency_key ?? null,
            receivedAt: event.created
              ? new Date(event.created * 1000)
              : new Date(),
          },
        );
        break;
      case 'invoice.paid':
        await this.onInvoicePaid(event.data.object as WebhookInvoicePayload, event.id);
        break;
      case 'invoice.payment_failed':
        await this.onInvoicePaymentFailed(event.data.object as WebhookInvoicePayload);
        break;
      case 'payment_intent.succeeded':
        await this.onPaymentIntentSucceeded(event.data.object as WebhookPaymentIntentPayload, event.id);
        break;
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
        await this.onPaymentIntentNotSucceeded(
          event.data.object as WebhookPaymentIntentPayload,
          event.type,
          event.id,
        );
        break;
      // Delivered only once the Stripe endpoint subscribes to them (release step); mirrored
      // into Payment status + a reconciliation case, never into access.
      case 'charge.refunded':
        await this.onChargeRefunded(event.data.object as WebhookChargePayload, event.id);
        break;
      case 'charge.dispute.created':
        await this.onChargeDisputed(event.data.object as WebhookDisputePayload, event.id);
        break;
      default:
        break;
    }
  }

  private async onCheckoutSessionCompleted(session: WebhookCheckoutSessionPayload): Promise<void> {
    if (session.mode !== 'subscription') {
      return;
    }
    if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
      return;
    }
    const subId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription && typeof session.subscription !== 'string'
          ? session.subscription.id
          : null;
    if (!subId) {
      return;
    }
    const md = readTriplet(session.metadata);
    const stripeSub = (await this.stripe.retrieveSubscription(subId)) as unknown as WebhookSubscriptionPayload;
    await this.upsertSubscriptionFromStripe(stripeSub, md, 'checkout.session.completed');

    // Enrollment finalization — only when metadata signals an enrollment-aware checkout
    const sessionMeta = session.metadata ?? {};
    const enrollmentSettingsId = sessionMeta['enrollmentSettingsId'];
    const userId = sessionMeta['userId'];
    const studioId = sessionMeta['studioId'];
    if (enrollmentSettingsId && userId && studioId) {
      await this.enrollment.finalizeEnrollment({
        userId,
        studioId,
        settingsId: enrollmentSettingsId,
        stripeCheckoutSessionId: session.id,
        wasPromoCandidate: sessionMeta['enrollmentCandidate'] === 'true',
      });
    }
  }

  private async onCustomerSubscription(
    subscription: WebhookSubscriptionPayload,
    eventContext: SubscriptionEventContext,
  ): Promise<void> {
    const md = readTriplet(subscription.metadata);
    await this.upsertSubscriptionFromStripe(subscription, md, eventContext.eventType, eventContext);
  }

  private async upsertSubscriptionFromStripe(
    sub: WebhookSubscriptionPayload,
    sessionOrRootMetadata: { userId?: string; studioId?: string; planId?: string },
    stripeEventType: string,
    eventContext?: SubscriptionEventContext,
  ): Promise<void> {
    const md = { ...readTriplet(sub.metadata), ...sessionOrRootMetadata };

    let userId = md.userId ?? null;
    const customerId =
      typeof sub.customer === 'string'
        ? sub.customer
        : sub.customer?.id ?? null;
    if (!userId && customerId) {
      const user = await this.prisma.user.findFirst({
        where: { stripeCustomerId: customerId, deletedAt: null },
      });
      userId = user?.id ?? null;
    }

    let studioId = md.studioId ?? null;
    const currentStripePriceId = readCurrentStripePriceId(sub);
    let fallbackPlanId = md.planId ?? null;

    if ((!fallbackPlanId || !studioId) && sub.items?.data.length) {
      const stripePriceId = sub.items.data[0]?.price?.id ?? null;
      if (stripePriceId) {
        const byPrice = await this.prisma.membershipPlan.findFirst({
          where: { stripePriceId, deletedAt: null },
        });
        if (byPrice) {
          fallbackPlanId = fallbackPlanId ?? byPrice.id;
          studioId = studioId ?? byPrice.studioId;
        }
      }
    }

    if (!userId || !studioId) {
      this.logger.warn(`Subscription ${sub.id} missing metadata; skipping DB upsert`);
      return;
    }

    const status = mapStripeSubscriptionStatus(sub.status);

    const currentPeriodStart = parseStripePeriodDate(sub.items?.data?.[0]?.current_period_start);
    const currentPeriodEnd   = parseStripePeriodDate(sub.items?.data?.[0]?.current_period_end);
    const periodData =
      currentPeriodStart &&
      currentPeriodEnd &&
      currentPeriodStart.getTime() !== currentPeriodEnd.getTime()
        ? { currentPeriodStart, currentPeriodEnd }
        : {};

    // Out-of-order protection, step 1 (outside the member lock so it never waits on the network):
    // when the local row is already CANCELED and this event still calls the subscription alive,
    // Stripe's CURRENT state decides — never event order or timestamps. See stale-subscription-event.ts.
    let liveLookup: LiveSubscriptionLookup | null = null;
    if (this.staleEventGuardEnabled() && !isTerminalStripeStatus(sub.status)) {
      const preRead = await this.prisma.subscription.findUnique({
        where: { stripeSubscriptionId: sub.id },
        select: { status: true },
      });
      if (preRead && needsLiveVerification(preRead.status, sub.status)) {
        liveLookup = await this.lookupLiveSubscription(sub.id);
      }
    }

    const saved = await this.prisma.$transaction(async (tx) => {
      // MM-4: unified member-scoped subscription-write lock — serialises concurrent webhook
      // deliveries AND cash sales / scheduled-cash creation for the same member, preventing
      // races where two paths both pass the conflict check and both try to CREATE.
      await acquireSubscriptionWriteAdvisoryLock(tx, studioId, userId);

      const { membershipPlanId, pendingMembershipPlanId } =
        await this.subscriptionLifecycle.reconcileSubscriptionPlansFromStripe(tx, {
          stripeSubscriptionId: sub.id,
          stripePriceId: currentStripePriceId,
          metadata: sub.metadata,
          fallbackPlanId,
        });

      if (!membershipPlanId) {
        this.logger.warn(
          `Subscription ${sub.id} could not resolve effective plan; skipping DB upsert`,
        );
        return null;
      }

      const plan = await tx.membershipPlan.findFirst({
        where: { id: membershipPlanId, studioId, deletedAt: null },
        select: {
          id: true,
          name: true,
          billingInterval: true,
          entitlementDays: true,
          exclusiveGroup: true,
        },
      });
      if (!plan) {
        this.logger.warn(
          `Plan ${membershipPlanId} not found for studio ${studioId}; skipping subscription upsert`,
        );
        return null;
      }
      // Fixed-duration entitlement is granted only by invoice.paid. Subscription events
      // may arrive before payment and therefore must never create an access window.
      const entitlementEndsAt = undefined;

      // Guard against violating the partial unique index on (studio_id, user_id) WHERE status='ACTIVE'.
      // Only the CREATE branch of upsert can conflict; the UPDATE branch targets the existing row by
      // stripeSubscriptionId and never inserts a second ACTIVE row.
      const existingRowForThisSub = await tx.subscription.findUnique({
        where: { stripeSubscriptionId: sub.id },
        select: {
          id: true,
          cancelAtPeriodEnd: true,
          status: true,
          endReason: true,
          supersededBySubscriptionId: true,
          membershipPlanId: true,
          pendingMembershipPlanId: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
        },
      });
      const previousCancelAtPeriodEnd =
        existingRowForThisSub == null ? null : existingRowForThisSub.cancelAtPeriodEnd;

      // Out-of-order protection, step 2 (under the member lock). A CANCELED row is terminal for
      // this Stripe id: Stripe never un-cancels, so an "alive" event here is either stale or a
      // GymOS-side cancellation Stripe does not know about. Neither may rewrite the row.
      if (
        this.staleEventGuardEnabled() &&
        existingRowForThisSub &&
        needsLiveVerification(existingRowForThisSub.status, sub.status)
      ) {
        const verdict = judgeTerminalConflict({
          localStatus: existingRowForThisSub.status,
          incomingStripeStatus: sub.status,
          live: liveLookup,
        });
        if (verdict.action === 'RETRY_UNVERIFIED') {
          // Fail closed: the event stays unprocessed (visible) and Stripe redelivers it.
          throw new StaleSubscriptionEventUnverifiedError(sub.id, verdict.error);
        }
        if (verdict.action === 'IGNORE_STALE') {
          this.logger.warn(
            JSON.stringify({
              event: 'stale_subscription_event_ignored',
              stripeEventId: eventContext?.eventId ?? null,
              stripeEventType,
              stripeSubscriptionId: sub.id,
              localSubscriptionId: existingRowForThisSub.id,
              localStatus: existingRowForThisSub.status,
              eventStatus: sub.status,
              liveStatus: verdict.liveStatus,
            }),
          );
          return null;
        }
        // KEEP_LOCAL_OPEN_CASE — Stripe keeps the subscription alive (and billing) while GymOS
        // canceled it. Not auto-reactivated: an operator decides, from a durable case (observed
        // after this transaction commits, so a concurrent observer can never abort it).
        if (verdict.action !== 'KEEP_LOCAL_OPEN_CASE') {
          throw new StaleSubscriptionEventUnverifiedError(sub.id, `unexpected verdict ${verdict.action}`);
        }
        this.logger.warn(
          JSON.stringify({
            event: 'subscription_event_kept_local_canceled',
            stripeEventId: eventContext?.eventId ?? null,
            stripeEventType,
            stripeSubscriptionId: sub.id,
            localSubscriptionId: existingRowForThisSub.id,
            liveStatus: verdict.liveStatus,
          }),
        );
        return {
          row: null,
          previousCancelAtPeriodEnd,
          keepLocalCase: {
          studioId,
          category: 'LOCAL_CANCELED_STRIPE_ALIVE',
          severity: 'HIGH',
          reasonCode: 'STRIPE_EVENT_AFTER_LOCAL_CANCEL',
          issueRef: existingRowForThisSub.id,
          userId,
          subscriptionId: existingRowForThisSub.id,
          stripeSubscriptionId: sub.id,
          stripeCustomerId: customerId,
          stripeEventId: eventContext?.eventId ?? null,
          title: 'GymOS canceló la suscripción, pero Stripe la mantiene vigente',
          summary: `Stripe reporta la suscripción como «${verdict.liveStatus}» y GymOS la tiene cancelada (${existingRowForThisSub.endReason ?? 'sin motivo'}). Mientras siga vigente en Stripe puede seguir cobrando; el evento de Stripe no reactivó la membresía.`,
          suggestedAction:
            'Decide en Stripe: cancela la suscripción si la membresía ya no aplica, o corrige la membresía en GymOS si el miembro sí debe tener acceso. No cobres manualmente.',
          evidence: {
            localStatus: existingRowForThisSub.status,
            localEndReason: existingRowForThisSub.endReason,
            stripeStatus: verdict.liveStatus,
            eventStatus: sub.status,
            stripeEventType,
            stripeEventId: eventContext?.eventId ?? null,
            planId: membershipPlanId,
          },
          } satisfies ObservedIssue,
        };
      }

      if (RENEWABLE_SUBSCRIPTION_STATUSES.includes(status)) {
        if (!existingRowForThisSub) {
          // MM-4 creation acceptance (gated): with stacking allowed, only a same-plan/
          // same-exclusive-group row conflicts — a legitimately paid COMPATIBLE
          // subscription (e.g. Booty Lab arriving while Full Access is active) falls
          // through to the upsert below and creates its own local row; it must never be
          // silently dropped/acknowledged as a conflict. With stacking disabled, every
          // renewable row blocks the NEW row (legacy acceptance) — and the conflict
          // handler below never mutates a live sibling (it only supersedes expired cash).
          const renewableRows = await tx.subscription.findMany({
            where: { studioId, userId, status: { in: RENEWABLE_SUBSCRIPTION_STATUSES } },
            include: { membershipPlan: { select: { exclusiveGroup: true } } },
            orderBy: { createdAt: 'desc' },
          });
          const conflictingRow = findCreationConflicts(
            renewableRows.map((r) => ({
              row: r,
              membershipPlanId: r.membershipPlanId,
              exclusiveGroupKey: r.exclusiveGroupKey,
            })),
            { id: plan.id, exclusiveGroup: plan.exclusiveGroup },
          )[0]?.row;
          if (conflictingRow) {
            return {
              row: await this.handleWebhookActiveConflict(tx, {
                conflictingRow,
                incomingSub: sub,
                incomingStatus: status,
                incomingMembershipPlanId: membershipPlanId,
                incomingExclusiveGroup: plan.exclusiveGroup,
                incomingPendingMembershipPlanId: pendingMembershipPlanId,
                incomingPeriodData: periodData,
                entitlementEndsAt,
                studioId,
                userId,
                stripeEventType,
              }),
              previousCancelAtPeriodEnd,
            };
          }
        }
      }

      let row: Subscription;
      if (!existingRowForThisSub) {
        row = await tx.subscription.create({
          data: {
            studioId,
            userId,
            membershipPlanId,
            pendingMembershipPlanId,
            // A fixed-duration row is not entitled until its paid invoice creates a cycle.
            status: plan.entitlementDays != null && status !== SubscriptionStatus.CANCELED ? SubscriptionStatus.PAST_DUE : status,
            stripeSubscriptionId: sub.id,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            // MM-1: purchase-time snapshot of the plan's exclusivity group.
            exclusiveGroupKey: plan.exclusiveGroup,
            ...periodData,
            // entitlementEndsAt is set only at creation — decoupled from Stripe period updates
            ...(entitlementEndsAt !== undefined ? { entitlementEndsAt } : {}),
          },
        });
      } else {
        // Fixed-duration rows keep the period of their paid cycle (re-pinned below), so Stripe's
        // billing period is never written to them — writing it would only bump updated_at twice.
        const periodWrite = plan.entitlementDays != null ? {} : periodData;
        const sameTime = (a: Date | null, b: Date | undefined) => (b === undefined ? true : a !== null && a.getTime() === b.getTime());
        const unchanged =
          existingRowForThisSub.status === status &&
          existingRowForThisSub.cancelAtPeriodEnd === sub.cancel_at_period_end &&
          existingRowForThisSub.membershipPlanId === membershipPlanId &&
          existingRowForThisSub.pendingMembershipPlanId === pendingMembershipPlanId &&
          sameTime(existingRowForThisSub.currentPeriodStart, periodWrite.currentPeriodStart) &&
          sameTime(existingRowForThisSub.currentPeriodEnd, periodWrite.currentPeriodEnd);
        if (!unchanged) {
          // Status-conditional write (optimistic concurrency): the row must still be in the status
          // read under the lock. A writer that bypasses the member lock (staff status override,
          // cash sale supersession) makes this a no-op, and the event is retried against fresh
          // state rather than overwriting it. A redelivery that changes nothing is not written at
          // all: `updated_at` is the cancellation date analytics read, and must not drift.
          const written = await tx.subscription.updateMany({
            where: { id: existingRowForThisSub.id, status: existingRowForThisSub.status },
            data: {
              status,
              cancelAtPeriodEnd: sub.cancel_at_period_end,
              membershipPlanId,
              pendingMembershipPlanId,
              ...periodWrite,
              // entitlementEndsAt deliberately omitted from update — never overwritten by Stripe
            },
          });
          if (written.count !== 1) {
            throw new ConcurrentSubscriptionWriteError(sub.id, existingRowForThisSub.status);
          }
        }
        row = await tx.subscription.findUniqueOrThrow({ where: { id: existingRowForThisSub.id } });
      }

      if (plan.entitlementDays != null) {
        const paidCycle = await tx.membershipEntitlementCycle.findFirst({
          where: { subscriptionId: row.id },
          orderBy: { endsAt: 'desc' },
        });
        const desired = paidCycle
          ? {
              status,
              currentPeriodStart: paidCycle.startsAt,
              currentPeriodEnd: paidCycle.endsAt,
              entitlementEndsAt: paidCycle.endsAt,
            }
          : {
              // Unpaid fixed-duration rows wait as PAST_DUE — unless Stripe already ended the
              // subscription, which must never leave a renewable (PAST_DUE) row behind.
              status: status === SubscriptionStatus.CANCELED ? SubscriptionStatus.CANCELED : SubscriptionStatus.PAST_DUE,
              currentPeriodStart: row.currentPeriodStart,
              currentPeriodEnd: row.currentPeriodEnd,
              entitlementEndsAt: null as Date | null,
            };
        const same = (a: Date | null, b: Date | null) => (a === null ? b === null : b !== null && a.getTime() === b.getTime());
        const alreadyThere =
          row.status === desired.status &&
          same(row.currentPeriodStart, desired.currentPeriodStart) &&
          same(row.currentPeriodEnd, desired.currentPeriodEnd) &&
          same(row.entitlementEndsAt, desired.entitlementEndsAt);
        if (!alreadyThere) {
          row = await tx.subscription.update({ where: { id: row.id }, data: desired });
        }
      }

      if (status === SubscriptionStatus.CANCELED) {
        // MM-3: only a successor belonging to the ENDING membership's plan/family may be
        // linked or activated. A Booty Lab cancellation must never touch a Full Access
        // cash successor (and vice versa).
        const scheduledCashRows = await tx.subscription.findMany({
          where: {
            studioId,
            userId,
            status: SubscriptionStatus.SCHEDULED,
            source: SubscriptionSource.CASH,
          },
          include: { membershipPlan: { select: { exclusiveGroup: true } } },
          orderBy: { createdAt: 'desc' },
        });
        const pendingCash = findConflictingMemberships(
          scheduledCashRows.map((r) => ({
            row: r,
            membershipPlanId: r.membershipPlanId,
            exclusiveGroupKey: r.exclusiveGroupKey,
          })),
          { id: plan.id, exclusiveGroup: plan.exclusiveGroup },
        )[0]?.row ?? null;
        if (row.endReason == null) {
          // Stripe's own facts decide between a requested cancellation and an involuntary end
          // (failed collection, dispute, never-paid first invoice). Never invents an actor.
          const endReason = resolveStripeEndReason(
            { status: sub.status, cancellationReason: readCancellationDetails(sub).reason },
            { pendingCashSuccessor: pendingCash !== null },
          );
          row = await tx.subscription.update({
            where: { id: row.id },
            data: {
              endReason,
              ...(pendingCash
                ? { supersededBySubscriptionId: pendingCash.id }
                : {}),
            },
          });
        } else if (pendingCash && row.supersededBySubscriptionId == null) {
          row = await tx.subscription.update({
            where: { id: row.id },
            data: { supersededBySubscriptionId: pendingCash.id },
          });
        }
        await this.stripeToCash.activateScheduledCashIfDue(tx, {
          studioId,
          userId,
          forPlan: { id: plan.id, exclusiveGroup: plan.exclusiveGroup },
        });
      }

      if (RENEWABLE_SUBSCRIPTION_STATUSES.includes(status)) {
        await this.subscriptionLifecycle.auditDuplicateRenewableSubscriptions(tx, {
          studioId,
          userId,
          keepSubscriptionId: row.id,
          keepStripeSubscriptionId: sub.id,
          source: 'webhook',
          stripeEventType,
        });
      }

      return { row, previousCancelAtPeriodEnd, keepLocalCase: null as ObservedIssue | null };
    });

    if (saved?.keepLocalCase) {
      await this.billingCases.observe(this.prisma, saved.keepLocalCase);
    }
    if (!saved?.row) return;

    const { row: savedRow, previousCancelAtPeriodEnd } = saved;

    if (
      eventContext &&
      previousCancelAtPeriodEnd !== null &&
      previousCancelAtPeriodEnd !== sub.cancel_at_period_end
    ) {
      const cancellation = readCancellationDetails(sub);
      await this.stripeRenewalAudit.maybeLogExternalRenewalChange({
        studioId,
        memberUserId: userId,
        subscriptionId: savedRow.id,
        stripeSubscriptionId: sub.id,
        previousCancelAtPeriodEnd,
        newCancelAtPeriodEnd: sub.cancel_at_period_end,
        currentPeriodEnd: savedRow.currentPeriodEnd,
        stripeEventId: eventContext.eventId,
        stripeEventType: eventContext.eventType,
        stripeRequestId: eventContext.requestId,
        stripeIdempotencyKey: eventContext.idempotencyKey,
        cancellationReason: cancellation.reason,
        cancellationFeedback: cancellation.feedback,
        receivedAt: eventContext.receivedAt,
      });
    }

    if (
      readPendingPlanIdFromMetadata(sub.metadata) &&
      savedRow.pendingMembershipPlanId &&
      savedRow.membershipPlanId !== savedRow.pendingMembershipPlanId
    ) {
      this.logger.log(
        JSON.stringify({
          event: 'scheduled_plan_change_pending',
          stripeSubscriptionId: sub.id,
          effectivePlanId: savedRow.membershipPlanId,
          pendingPlanId: savedRow.pendingMembershipPlanId,
          currentPeriodEnd: savedRow.currentPeriodEnd?.toISOString() ?? null,
        }),
      );
    }
  }

  /**
   * Called when a new Stripe subscription webhook arrives for a user/studio that already has
   * an ACTIVE local subscription under a different (or no) stripeSubscriptionId — a state
   * that would violate the partial unique index on (studio_id, user_id) WHERE status='ACTIVE'.
   *
   * Decision matrix:
   *
   *  A. Conflicting row is CASH and its service period has definitively ended
   *     (source=CASH, currentPeriodEnd < now):
   *     → Safe supersede. CANCEL the stale CASH row, CREATE the incoming Stripe-backed row.
   *     → Represents: member purchased a new Stripe subscription after an expired offline period.
   *
   *  B. Conflicting row is Stripe-backed (has a different stripeSubscriptionId):
   *     → Potential duplicate renewable Stripe subscriptions. Auto-cancellation is forbidden.
   *     → Acknowledge webhook (return null → processed=true), log structured error.
   *     → The reconciliation service will surface the incoming sub as a stripe_orphan.
   *
   *  C. Conflicting row is CASH with an active service period:
   *     → Cannot auto-supersede without cancelling a member's still-valid access.
   *     → Acknowledge webhook (return null → processed=true), log structured error.
   *     → The reconciliation service will surface the incoming sub as a stripe_orphan.
   *
   * Returning null commits the outer transaction cleanly — no P2002 is thrown and Stripe
   * stops retrying. Returning a Subscription row commits the safe supersede.
   */
  private async handleWebhookActiveConflict(
    tx: Prisma.TransactionClient,
    params: {
      conflictingRow: Subscription;
      incomingSub: WebhookSubscriptionPayload;
      incomingStatus: SubscriptionStatus;
      incomingMembershipPlanId: string;
      incomingExclusiveGroup: string | null;
      incomingPendingMembershipPlanId: string | null;
      incomingPeriodData: { currentPeriodStart?: Date; currentPeriodEnd?: Date };
      entitlementEndsAt?: Date;
      studioId: string;
      userId: string;
      stripeEventType: string;
    },
  ): Promise<Subscription | null> {
    const { conflictingRow, incomingSub, studioId, userId, stripeEventType } = params;

    // Case A: the conflicting row is a CASH subscription whose service period has ended.
    // The member has since purchased a real Stripe subscription — safe to supersede.
    const isExpiredCash =
      conflictingRow.source === SubscriptionSource.CASH &&
      conflictingRow.currentPeriodEnd !== null &&
      conflictingRow.currentPeriodEnd < new Date();

    if (isExpiredCash) {
      const created = await tx.subscription.create({
        data: {
          studioId,
          userId,
          membershipPlanId: params.incomingMembershipPlanId,
          pendingMembershipPlanId: params.incomingPendingMembershipPlanId,
          status: params.incomingStatus,
          stripeSubscriptionId: incomingSub.id,
          cancelAtPeriodEnd: incomingSub.cancel_at_period_end,
          exclusiveGroupKey: params.incomingExclusiveGroup,
          ...params.incomingPeriodData,
          ...(params.entitlementEndsAt !== undefined ? { entitlementEndsAt: params.entitlementEndsAt } : {}),
        },
      });
      await tx.subscription.update({
        where: { id: conflictingRow.id },
        data: {
          status: SubscriptionStatus.CANCELED,
          endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD,
          supersededBySubscriptionId: created.id,
        },
      });
      this.logger.log(
        JSON.stringify({
          event: 'webhook_superseded_expired_cash_subscription',
          canceledLocalId: conflictingRow.id,
          supersededBySubscriptionId: created.id,
          incomingStripeSubId: incomingSub.id,
          stripeEventType,
          studioId,
          userId,
        }),
      );
      return created;
    }

    // Cases B and C: cannot auto-resolve without risking incorrect financial decisions.
    // Acknowledge the webhook (no throw → no Stripe retry storm) and log for operators.
    // The incoming Stripe subscription becomes a detectable stripe_orphan for the
    // reconciliation service to surface on the next reconciliation check.
    const conflictKind =
      conflictingRow.stripeSubscriptionId !== null
        ? 'stripe_backed_conflict'
        : 'active_cash_conflict';

    this.logger.error(
      JSON.stringify({
        event: 'webhook_subscription_conflict_acknowledged',
        conflictKind,
        incomingStripeSubId: incomingSub.id,
        existingLocalId: conflictingRow.id,
        existingLocalStatus: conflictingRow.status,
        existingLocalSource: conflictingRow.source,
        existingLocalStripeSubId: conflictingRow.stripeSubscriptionId ?? null,
        existingPeriodEnd: conflictingRow.currentPeriodEnd?.toISOString() ?? null,
        stripeEventType,
        studioId,
        userId,
        action: 'acknowledged_no_local_mutation',
        resolution: 'manual_reconciliation_required',
      }),
    );

    return null;
  }

  /**
   * Resolves userId, studioId, DB subscriptionId, and membershipPlanId from an invoice.
   *
   * Resolution order:
   *   1. readInvoiceSubscriptionId() — handles both legacy and basil invoice shapes
   *   2. DB lookup by Stripe subscription ID
   *   3. Basil parent.subscription_details.metadata fallback (validated)
   *   4. Stripe API subscription metadata lookup
   */
  private async resolveInvoiceContext(invoice: WebhookInvoicePayload): Promise<{
    userId: string;
    studioId: string;
    dbSubscriptionId: string | null;
    membershipPlanId: string | null;
  } | null> {
    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
    if (!customerId) return null;

    const user = await this.prisma.user.findFirst({
      where: { stripeCustomerId: customerId, deletedAt: null },
    });
    if (!user) return null;

    const stripeSubId = readInvoiceSubscriptionId(invoice);

    if (stripeSubId) {
      // Path 1: DB lookup by Stripe subscription ID (fast path)
      const dbSub = await this.prisma.subscription.findUnique({
        where: { stripeSubscriptionId: stripeSubId },
      });
      if (dbSub) {
        return {
          userId: user.id,
          studioId: dbSub.studioId,
          dbSubscriptionId: dbSub.id,
          membershipPlanId: dbSub.membershipPlanId,
        };
      }

      // Path 2: Basil metadata fallback — subscription exists in Stripe but not yet in DB
      // (e.g. invoice.paid raced ahead of customer.subscription.created)
      const basilCtx = await this.resolveFromBasilMetadata(invoice, user.id);
      if (basilCtx) return basilCtx;

      // Path 3: Stripe API lookup — get studioId from subscription metadata
      const stripeSub = (await this.stripe.retrieveSubscription(
        stripeSubId,
      )) as unknown as WebhookSubscriptionPayload;
      const studioId = readTriplet(stripeSub.metadata).studioId;
      if (!studioId) return null;
      return { userId: user.id, studioId, dbSubscriptionId: null, membershipPlanId: null };
    }

    // Path 4: No subscription ID resolved — try basil metadata as last resort
    return this.resolveFromBasilMetadata(invoice, user.id);
  }

  /**
   * Validates and resolves context from invoice.parent.subscription_details.metadata.
   * Enforces tenant isolation: userId in metadata must match the Stripe customer's user,
   * plan must belong to studio, and user must have a membership in the studio.
   */
  private async resolveFromBasilMetadata(
    invoice: WebhookInvoicePayload,
    expectedUserId: string,
  ): Promise<{
    userId: string;
    studioId: string;
    dbSubscriptionId: null;
    membershipPlanId: string | null;
  } | null> {
    const md = readTriplet(invoice.parent?.subscription_details?.metadata ?? null);
    if (!md.studioId || !md.userId || !md.planId) return null;

    // Tenant isolation: metadata userId must match the Stripe customer's DB user
    if (md.userId !== expectedUserId) return null;

    // Validate plan belongs to the studio
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: md.planId, studioId: md.studioId, deletedAt: null },
    });
    if (!plan) return null;

    // Validate user has membership in the studio
    const membership = await this.prisma.studioMembership.findFirst({
      where: { userId: expectedUserId, studioId: md.studioId, deletedAt: null },
    });
    if (!membership) return null;

    return {
      userId: expectedUserId,
      studioId: md.studioId,
      dbSubscriptionId: null,
      membershipPlanId: md.planId,
    };
  }

  private async onInvoicePaid(invoice: WebhookInvoicePayload, stripeEventId?: string): Promise<void> {
    if (invoice.status !== 'paid') {
      return;
    }
    const ctx = await this.resolveInvoiceContext(invoice);
    if (!ctx) {
      const customerId =
        typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
      // Emit a structured ERROR (not warn) so this is queryable in production logs.
      // The webhook is still marked processed to avoid infinite Stripe retries — but
      // the log entry is the inspectable record that no Payment row was created.
      this.logger.error(
        JSON.stringify({
          event: 'invoice_paid_skipped',
          reason: 'context_resolution_failed',
          invoiceId: invoice.id,
          customerId,
          stripeSubscriptionIdLegacy: invoice.subscription ?? null,
          stripeSubscriptionIdBasil: invoice.parent?.subscription_details?.subscription ?? null,
          stripeSubscriptionIdResolved: readInvoiceSubscriptionId(invoice),
          amountCents: invoice.amount_paid,
          currency: invoice.currency,
        }),
      );
      return;
    }

    const amountCents = invoice.amount_paid ?? 0;
    if (amountCents <= 0) {
      // Discounts and customer balance can settle a real fixed-duration period without a
      // positive Stripe payment: grant that exact period, but never write a zero-value
      // financial Payment row. Trials and bridges are recognised and skipped.
      const fixed = await this.loadFixedDurationSubscription(ctx.dbSubscriptionId);
      if (!fixed && !ctx.dbSubscriptionId && (await this.isFixedDurationPlan(ctx.membershipPlanId))) {
        // A zero-value fixed-duration invoice (e.g. 100% coupon) that raced ahead of its local
        // subscription row must be retried, not silently skipped: the grant path throws a
        // retryable SUBSCRIPTION_NOT_LOCAL error.
        await this.grantFixedDurationCycleForPaidInvoice(ctx, invoice, stripeEventId);
        return;
      }
      if (!fixed) await this.assertNoUnsyncedFixedDurationSwitch(ctx, invoice, stripeEventId);
      const decision = fixed ? this.classifyForSubscription(invoice, fixed) : null;
      if (!decision || decision.kind === 'skip') {
        this.logger.log(
          JSON.stringify({
            event: 'stripe_invoice_paid_non_entitlement',
            stripeEventId: stripeEventId ?? null,
            stripeInvoiceId: invoice.id,
            subscriptionId: readInvoiceSubscriptionId(invoice),
            amountDue: invoice.amount_due ?? 0,
            amountPaid: amountCents,
            billingReason: invoice.billing_reason ?? null,
            reasonSkipped: decision ? decision.reason : 'not_fixed_duration_membership',
          }),
        );
        return;
      }
      // A coupon/balance-settled period obeys the same late-payment policy as a paid one: no
      // window on a superseded or double-covered membership, and nothing silent.
      const zeroPolicy = await this.applyPaidInvoicePolicy(ctx, invoice, stripeEventId, { priorPaymentStatus: null, amountPaidCents: 0 });
      if (!zeroPolicy.decision.allowEntitlementGrant) {
        this.logger.warn(JSON.stringify({ event: 'stripe_invoice_paid_zero_amount_withheld', stripeEventId: stripeEventId ?? null, stripeInvoiceId: invoice.id, reason: zeroPolicy.decision.exception?.reasonCode ?? null }));
        if (zeroPolicy.recordException) await zeroPolicy.recordException();
        return;
      }
      await this.grantFixedDurationCycleForPaidInvoice(ctx, invoice, stripeEventId);
      if (zeroPolicy.recordException) await zeroPolicy.recordException();
      return;
    }
    // Pre-basil payloads embed the PaymentIntent; basil-and-later (the live dahlia endpoint) do
    // not — those are enriched best-effort AFTER the entitlement grant (see below).
    const piId =
      typeof invoice.payment_intent === 'string'
        ? invoice.payment_intent
        : invoice.payment_intent?.id ?? null;
    const paidAt = invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000)
      : new Date();

    // What this invoice's Payment row said BEFORE this delivery drives the late-payment policy
    // (a recovered failure vs. an idempotent redelivery vs. a first observation).
    const priorPayment = await this.prisma.payment.findUnique({
      where: { stripeInvoiceId: invoice.id },
      select: { status: true },
    });

    // Keyed by stripeInvoiceId — idempotent on Stripe retries. Recorded BEFORE the entitlement
    // grant on purpose: the financial fact must never be lost, even when the grant below needs
    // review. A stored Payment never short-circuits the grant, so a retry/replay still repairs a
    // missing cycle.
    await this.prisma.payment.upsert({
      where: { stripeInvoiceId: invoice.id },
      create: {
        studioId: ctx.studioId,
        userId: ctx.userId,
        subscriptionId: ctx.dbSubscriptionId,
        membershipPlanId: ctx.membershipPlanId,
        amountCents,
        currency: (invoice.currency ?? 'usd').toLowerCase(),
        status: PaymentStatus.SUCCEEDED,
        paymentMethod: PaymentMethod.STRIPE,
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: piId,
        paidAt,
      },
      update: {
        status: PaymentStatus.SUCCEEDED,
        paymentMethod: PaymentMethod.STRIPE,
        amountCents,
        currency: (invoice.currency ?? 'usd').toLowerCase(),
        stripePaymentIntentId: piId ?? undefined,
        subscriptionId: ctx.dbSubscriptionId ?? undefined,
        membershipPlanId: ctx.membershipPlanId ?? undefined,
        paidAt,
      },
    });

    // Late-payment policy: money is recorded above regardless; this decides whether the paid
    // period may become entitlement and whether an operator must see it (paid-invoice-policy.ts).
    const policy = await this.applyPaidInvoicePolicy(ctx, invoice, stripeEventId, {
      priorPaymentStatus: priorPayment?.status ?? null,
      amountPaidCents: amountCents,
    });

    if (policy.decision.allowEntitlementGrant) {
      // Grant first: the case (if any) must describe what actually happened, and a grant that
      // needs review dead-letters visibly instead of leaving a case that claims a window.
      await this.grantFixedDurationCycleForPaidInvoice(ctx, invoice, stripeEventId);
    }
    if (policy.recordException) await policy.recordException();

    if (!piId) await this.enrichPaymentIntentReference(invoice.id);
  }

  /**
   * Classifies a paid invoice against the local membership and (when the local row is terminal)
   * Stripe's current state, and turns any exception into a durable reconciliation case. Never
   * refunds, voids, reactivates or grants anything itself.
   */
  private async applyPaidInvoicePolicy(
    ctx: InvoiceContext,
    invoice: WebhookInvoicePayload,
    stripeEventId: string | undefined,
    input: { priorPaymentStatus: PaymentStatus | null; amountPaidCents: number },
  ): Promise<{ decision: PaidInvoiceDecision; recordException: (() => Promise<void>) | null }> {
    const row = ctx.dbSubscriptionId
      ? await this.prisma.subscription.findUnique({
          where: { id: ctx.dbSubscriptionId },
          select: {
            id: true,
            userId: true,
            studioId: true,
            status: true,
            endReason: true,
            supersededBySubscriptionId: true,
            cancelAtPeriodEnd: true,
            currentPeriodEnd: true,
            updatedAt: true,
            membershipPlanId: true,
            exclusiveGroupKey: true,
            membershipPlan: { select: { name: true, entitlementDays: true } },
          },
        })
      : null;

    const terminalLocally = row !== null && (row.status === SubscriptionStatus.CANCELED || row.supersededBySubscriptionId !== null);
    const stripeSubscriptionId = readInvoiceSubscriptionId(invoice);
    let liveStripeStatus: string | 'unavailable' | null = null;
    let entitledSiblingExists = false;
    let endedAt: Date | null = null;
    if (terminalLocally && stripeSubscriptionId) {
      const live = await this.lookupLiveSubscription(stripeSubscriptionId);
      liveStripeStatus = live.ok ? live.status : 'unavailable';
      // When the membership ended: Stripe's own deletion event (immutable), else the row's last write.
      const deletion = await this.prisma.stripeWebhookEvent.findFirst({
        where: { eventType: 'customer.subscription.deleted', payload: { path: ['data', 'object', 'id'], equals: stripeSubscriptionId } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      endedAt = deletion?.createdAt ?? row?.updatedAt ?? null;
    }
    if (row && row.status === SubscriptionStatus.CANCELED) {
      // A newer membership of the same family (same plan, or same non-null exclusive group) that
      // is renewable or still entitled means this payment would cover a period twice.
      const now = new Date();
      const sibling = await this.prisma.subscription.findFirst({
        where: {
          studioId: row.studioId,
          userId: row.userId,
          id: { not: row.id },
          OR: [{ membershipPlanId: row.membershipPlanId }, ...(row.exclusiveGroupKey ? [{ exclusiveGroupKey: row.exclusiveGroupKey }] : [])],
          AND: [{ OR: [{ status: { in: RENEWABLE_SUBSCRIPTION_STATUSES } }, { entitlementEndsAt: { gt: now } }, { status: SubscriptionStatus.CANCELED, entitlementEndsAt: null, currentPeriodEnd: { gt: now }, source: { not: SubscriptionSource.STRIPE } }] }],
        },
        select: { id: true },
      });
      entitledSiblingExists = sibling !== null;
    }

    const paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : null;
    const decision = decidePaidInvoice({
      invoiceId: invoice.id,
      amountPaidCents: input.amountPaidCents,
      billingReason: invoice.billing_reason ?? null,
      paidAt,
      subscription: row
        ? {
            id: row.id,
            status: row.status,
            endReason: row.endReason,
            supersededBySubscriptionId: row.supersededBySubscriptionId,
            cancelAtPeriodEnd: row.cancelAtPeriodEnd,
            isFixedDuration: row.membershipPlan.entitlementDays != null,
            endedAt,
          }
        : null,
      liveStripeStatus,
      paymentAlreadySucceeded: input.priorPaymentStatus === PaymentStatus.SUCCEEDED,
      paymentPreviouslyFailed: input.priorPaymentStatus === PaymentStatus.FAILED,
      entitledSiblingExists,
    });

    this.logger.log(
      JSON.stringify({
        event: 'paid_invoice_policy',
        stripeEventId: stripeEventId ?? null,
        stripeInvoiceId: invoice.id,
        localSubscriptionId: row?.id ?? null,
        scenario: decision.scenario,
        allowEntitlementGrant: decision.allowEntitlementGrant,
        exception: decision.exception?.reasonCode ?? null,
      }),
    );

    if (!decision.exception) return { decision, recordException: null };
    const exception = decision.exception;

    const recordException = async () => {
    const parsed = parseInvoiceLines(invoice.lines);
    const serviceLine = parsed.lines.find((l) => l.kind === 'subscription_item' && !l.proration) ?? parsed.lines[0] ?? null;
    const currency = (invoice.currency ?? 'mxn').toLowerCase();
    const paymentRow = await this.prisma.payment.findUnique({ where: { stripeInvoiceId: invoice.id }, select: { id: true } });
    const amountText = formatMoney(input.amountPaidCents, currency);
    const periodText = serviceLine
      ? `${formatDateEs(new Date(serviceLine.periodStart * 1000))} → ${formatDateEs(new Date(serviceLine.periodEnd * 1000))}`
      : 'periodo no identificado';
    const planName = row?.membershipPlan.name ?? 'membresía';
    const paidWithoutAccess = exception.paidWithoutAccess;
    const zeroAmount = input.amountPaidCents <= 0;
    // A row-level disagreement (Stripe alive, GymOS canceled) is keyed on the local row, exactly
    // like the nightly detector, so both observe ONE case; invoice-level exceptions key on the invoice.
    const rowLevel = exception.reasonCode === 'LOCAL_CANCELED_STRIPE_ALIVE' && !paidWithoutAccess && row !== null;

    await this.billingCases.observe(this.prisma, {
      studioId: ctx.studioId,
      category: rowLevel ? 'LOCAL_CANCELED_STRIPE_ALIVE' : 'PAID_WITHOUT_ENTITLEMENT',
      severity: zeroAmount && exception.severity === 'CRITICAL' ? 'MEDIUM' : exception.severity,
      reasonCode: rowLevel ? 'LATE_PAYMENT_STRIPE_ALIVE' : exception.reasonCode,
      issueRef: rowLevel ? row.id : invoice.id,
      userId: ctx.userId,
      subscriptionId: row?.id ?? null,
      paymentId: paymentRow?.id ?? null,
      stripeSubscriptionId,
      stripeInvoiceId: invoice.id,
      stripeCustomerId: typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null,
      stripeEventId: stripeEventId ?? null,
      title: zeroAmount
        ? `Factura sin cobro (cupón o saldo) ${paidWithoutAccess ? 'no otorgó' : 'otorgó'} vigencia de ${planName}`
        : paidWithoutAccess
          ? `Pago recibido sin acceso: ${amountText} de ${planName}`
          : `Pago tardío aplicado a una membresía cancelada: ${amountText} de ${planName}`,
      summary: `${exception.explanation} Factura ${invoice.id} (${invoice.billing_reason ?? 'motivo desconocido'}), periodo ${periodText}. Stripe: ${liveStripeStatus ?? 'no consultado'} · GymOS: ${row?.status ?? 'sin suscripción'}${row?.endReason ? ` (${row.endReason})` : ''}.`,
      suggestedAction: paidWithoutAccess
        ? 'Decide con el miembro: reembolsa en Stripe o vende/activa la membresía correcta en GymOS. No reactives la suscripción cancelada ni cobres de nuevo.'
        : 'Confirma que la vigencia otorgada es correcta; Stripe no volverá a renovar esta suscripción.',
      evidence: {
        amountCents: input.amountPaidCents,
        currency,
        stripeInvoiceId: invoice.id,
        billingReason: invoice.billing_reason ?? null,
        servicePeriodStart: serviceLine ? new Date(serviceLine.periodStart * 1000).toISOString() : null,
        servicePeriodEnd: serviceLine ? new Date(serviceLine.periodEnd * 1000).toISOString() : null,
        paidAt: invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000).toISOString() : null,
        entitlementGranted: !paidWithoutAccess,
        whyNotGranted: paidWithoutAccess ? exception.reasonCode : null,
        stripeStatus: liveStripeStatus,
        localStatus: row?.status ?? null,
        localEndReason: row?.endReason ?? null,
        localPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
        scenario: decision.scenario,
        paymentId: paymentRow?.id ?? null,
        entitledSiblingExists,
      },
    });
    };
    return { decision, recordException };
  }

  /**
   * Locates the Payment row a charge belongs to. Basil-and-later charges carry no `invoice`: the
   * PaymentIntent is matched directly, else resolved to its invoice through the InvoicePayment
   * resource (GET). A legacy `invoice` field, when present, is honoured first.
   */
  private async findPaymentForCharge(input: { invoice?: string | { id: string } | null; payment_intent: string | { id: string } | null }) {
    const invoiceId = typeof input.invoice === 'string' ? input.invoice : input.invoice?.id ?? null;
    const paymentIntentId = typeof input.payment_intent === 'string' ? input.payment_intent : input.payment_intent?.id ?? null;
    const select = { id: true, studioId: true, userId: true, subscriptionId: true, amountCents: true, currency: true, status: true, stripeInvoiceId: true, stripePaymentIntentId: true } as const;
    if (invoiceId) {
      const byInvoice = await this.prisma.payment.findUnique({ where: { stripeInvoiceId: invoiceId }, select });
      if (byInvoice) return byInvoice;
    }
    if (!paymentIntentId) return null;
    const byIntent = await this.prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId }, select });
    if (byIntent) return byIntent;
    try {
      const paidInvoiceId = await this.stripe.findInvoiceIdForPaymentIntent(paymentIntentId);
      if (paidInvoiceId) return this.prisma.payment.findUnique({ where: { stripeInvoiceId: paidInvoiceId }, select });
    } catch (err) {
      this.logger.warn(JSON.stringify({ event: 'charge_payment_lookup_failed', paymentIntentId, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) }));
    }
    return null;
  }

  private async onChargeRefunded(charge: WebhookChargePayload, stripeEventId: string): Promise<void> {
    const payment = await this.findPaymentForCharge(charge);
    if (!payment) {
      this.logger.warn(JSON.stringify({ event: 'charge_refunded_without_local_payment', stripeEventId, chargeId: charge.id }));
      return;
    }
    const amountRefunded = charge.amount_refunded ?? 0;
    const fullyRefunded = charge.refunded === true || (charge.amount !== null && amountRefunded >= charge.amount);
    const nextStatus = fullyRefunded ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
    // Mirror the money fact. Access is NOT revoked here: whether a refund ends a membership is a
    // decision the case asks an operator to make.
    await this.prisma.payment.updateMany({
      where: { id: payment.id, status: { in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED] } },
      data: { status: nextStatus },
    });
    const currency = (charge.currency ?? payment.currency ?? 'mxn').toLowerCase();
    await this.billingCases.observe(this.prisma, {
      studioId: payment.studioId,
      category: 'PAYMENT_REFUNDED_OR_DISPUTED',
      severity: 'MEDIUM',
      reasonCode: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
      issueRef: charge.id,
      userId: payment.userId,
      subscriptionId: payment.subscriptionId,
      paymentId: payment.id,
      stripeInvoiceId: payment.stripeInvoiceId,
      stripeCustomerId: typeof charge.customer === 'string' ? charge.customer : charge.customer?.id ?? null,
      stripeEventId,
      title: `${fullyRefunded ? 'Reembolso' : 'Reembolso parcial'} en Stripe: ${formatMoney(amountRefunded, currency)}`,
      summary: `Stripe reembolsó ${formatMoney(amountRefunded, currency)} de un pago de ${formatMoney(payment.amountCents, payment.currency)}. GymOS registró el reembolso en el historial de pagos y NO retiró el acceso.`,
      suggestedAction: 'Revisa si la vigencia pagada debe terminar antes o cancelarse; si fue un cobro duplicado, no se requiere más acción.',
      evidence: { chargeId: charge.id, amountCents: charge.amount, amountRefundedCents: amountRefunded, currency, stripeInvoiceId: payment.stripeInvoiceId, paymentStatus: nextStatus },
    });
  }

  private async onChargeDisputed(dispute: WebhookDisputePayload, stripeEventId: string): Promise<void> {
    const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id ?? null;
    const payment = await this.findPaymentForCharge({ invoice: null, payment_intent: dispute.payment_intent });
    if (!payment) {
      this.logger.warn(JSON.stringify({ event: 'charge_dispute_without_local_payment', stripeEventId, disputeId: dispute.id, chargeId }));
      return;
    }
    const currency = (dispute.currency ?? payment.currency ?? 'mxn').toLowerCase();
    await this.billingCases.observe(this.prisma, {
      studioId: payment.studioId,
      category: 'PAYMENT_REFUNDED_OR_DISPUTED',
      severity: 'HIGH',
      reasonCode: 'DISPUTED',
      issueRef: dispute.id,
      userId: payment.userId,
      subscriptionId: payment.subscriptionId,
      paymentId: payment.id,
      stripeInvoiceId: payment.stripeInvoiceId,
      stripeEventId,
      title: `Disputa de pago en Stripe: ${formatMoney(dispute.amount ?? payment.amountCents, currency)}`,
      summary: `El miembro disputó un cobro (${dispute.reason ?? 'motivo no indicado'}; estado ${dispute.status ?? 'desconocido'}). GymOS no cambió el acceso; Stripe puede cancelar la suscripción si la disputa procede.`,
      suggestedAction: 'Responde la disputa en Stripe y decide si la membresía debe seguir vigente mientras se resuelve.',
      evidence: { disputeId: dispute.id, chargeId, amountCents: dispute.amount, currency, reason: dispute.reason, status: dispute.status, stripeInvoiceId: payment.stripeInvoiceId },
    });
  }

  /**
   * Basil-and-later invoice payloads (the live endpoint is dahlia) no longer embed the
   * PaymentIntent. Best-effort, READ-ONLY Stripe lookup of the invoice's single paid
   * PaymentIntent so Payment rows stay traceable. Runs only after the Payment and entitlement
   * writes, fills the reference only when it is empty, and swallows every error: it can never
   * delay, fail or alter the payment/entitlement outcome.
   */
  private async enrichPaymentIntentReference(stripeInvoiceId: string): Promise<void> {
    try {
      const paymentIntentId = await this.stripe.findPaidInvoicePaymentIntentId(stripeInvoiceId);
      if (!paymentIntentId) return;
      // Payment.stripePaymentIntentId is unique: never move a reference held by another row.
      const holder = await this.prisma.payment.findUnique({
        where: { stripePaymentIntentId: paymentIntentId },
        select: { stripeInvoiceId: true },
      });
      if (holder) {
        if (holder.stripeInvoiceId !== stripeInvoiceId) {
          this.logger.warn(
            JSON.stringify({ event: 'invoice_payment_intent_already_linked', stripeInvoiceId, stripePaymentIntentId: paymentIntentId }),
          );
        }
        return;
      }
      await this.prisma.payment.updateMany({
        where: { stripeInvoiceId, stripePaymentIntentId: null },
        data: { stripePaymentIntentId: paymentIntentId },
      });
    } catch (err) {
      this.logger.warn(
        JSON.stringify({
          event: 'invoice_payment_intent_enrichment_skipped',
          stripeInvoiceId,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        }),
      );
    }
  }

  /**
   * A plan change from a non-fixed plan INTO a fixed-duration plan updates Stripe (invoice paid,
   * webhooks sent) before the local row switches plans. If invoice.paid wins that race, the local
   * row still looks non-fixed and the paid period would be skipped for good. When a linked,
   * non-proration line is billed at a Price/Product of one of the studio's fixed-duration plans,
   * fail retryably so Stripe re-delivers after customer.subscription.updated syncs the plan.
   */
  private async assertNoUnsyncedFixedDurationSwitch(
    ctx: InvoiceContext,
    invoice: WebhookInvoicePayload,
    stripeEventId?: string,
  ): Promise<void> {
    const invoiceSubscriptionId = readInvoiceSubscriptionId(invoice);
    if (!ctx.dbSubscriptionId || !invoiceSubscriptionId) return;
    const { lines } = parseInvoiceLines(invoice.lines);
    const serviceLines = lines.filter(
      (line) =>
        line.kind === 'subscription_item' &&
        !line.proration &&
        (line.subscriptionId ?? invoiceSubscriptionId) === invoiceSubscriptionId,
    );
    if (serviceLines.length === 0) return;
    const priceIds = serviceLines.map((l) => l.priceId).filter((id): id is string => !!id);
    const productIds = serviceLines.map((l) => l.productId).filter((id): id is string => !!id);
    const fixedPlans = await this.prisma.membershipPlan.findMany({
      where: {
        studioId: ctx.studioId,
        deletedAt: null,
        entitlementDays: { not: null },
        OR: [
          ...(priceIds.length ? [{ stripePriceId: { in: priceIds } }] : []),
          ...(productIds.length ? [{ stripeProductId: { in: productIds } }] : []),
        ],
      },
      select: { id: true, entitlementDays: true, stripePriceId: true, stripeProductId: true },
    });
    // Only a line billed like that fixed plan — its Price/Product AND its exact duration — counts.
    // A monthly line on a Product shared with a fixed plan never matches a 45-day period.
    const fixedPlan = fixedPlans.find((plan) =>
      serviceLines.some(
        (line) =>
          (line.priceId === plan.stripePriceId || (!!line.productId && line.productId === plan.stripeProductId)) &&
          Math.abs(line.periodEnd - line.periodStart - (plan.entitlementDays as number) * 86_400) <= 1,
      ),
    );
    if (!fixedPlan) return;
    throw this.entitlementFailure(
      new FixedDurationEntitlementError(
        'SUBSCRIPTION_PLAN_NOT_SYNCED',
        invoice.id,
        `Stripe bills fixed-duration plan ${fixedPlan.id} but local subscription ${ctx.dbSubscriptionId} has not switched yet; Stripe will retry`,
      ),
      { stripeEventId, invoice },
    );
  }

  private async isFixedDurationPlan(membershipPlanId: string | null): Promise<boolean> {
    if (!membershipPlanId) return false;
    const plan = await this.prisma.membershipPlan.findUnique({
      where: { id: membershipPlanId },
      select: { entitlementDays: true },
    });
    return plan?.entitlementDays != null;
  }

  private async loadFixedDurationSubscription(
    dbSubscriptionId: string | null,
  ): Promise<FixedDurationSubscription | null> {
    if (!dbSubscriptionId) return null;
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: dbSubscriptionId },
      include: { membershipPlan: true },
    });
    if (!subscription?.membershipPlan || subscription.membershipPlan.entitlementDays == null) return null;
    return subscription;
  }

  private classifyForSubscription(
    invoice: WebhookInvoicePayload,
    subscription: FixedDurationSubscription,
  ): FixedDurationDecision {
    const plan = subscription.membershipPlan;
    return classifyFixedDurationInvoice(
      {
        invoiceId: invoice.id,
        status: invoice.status,
        billingReason: invoice.billing_reason ?? null,
        amountPaid: invoice.amount_paid ?? 0,
        invoiceSubscriptionId: readInvoiceSubscriptionId(invoice),
        invoiceSubscriptionPlanId: invoice.parent?.subscription_details?.metadata?.['planId'] ?? null,
        lines: invoice.lines,
      },
      {
        stripeSubscriptionId: subscription.stripeSubscriptionId ?? null,
        planId: subscription.membershipPlanId,
        hasPendingPlanChange: subscription.pendingMembershipPlanId != null,
        plan: {
          entitlementDays: plan.entitlementDays as number,
          classCredits: plan.classCredits ?? null,
          stripePriceId: plan.stripePriceId ?? null,
          stripeProductId: plan.stripeProductId ?? null,
        },
      },
    );
  }

  /** Structured, PII-free record of a paid invoice that could not become an entitlement. */
  private entitlementFailure(
    error: FixedDurationEntitlementError,
    context: {
      stripeEventId?: string;
      invoice: WebhookInvoicePayload;
      subscription?: FixedDurationSubscription | null;
      lines?: InvoiceLineDiagnostic[];
    },
  ): FixedDurationEntitlementError {
    this.logger.error(
      JSON.stringify({
        event: 'fixed_duration_entitlement_grant_failed',
        code: error.code,
        stripeEventId: context.stripeEventId ?? null,
        stripeInvoiceId: context.invoice.id,
        stripeSubscriptionId: readInvoiceSubscriptionId(context.invoice),
        localSubscriptionId: context.subscription?.id ?? null,
        membershipPlanId: context.subscription?.membershipPlanId ?? null,
        billingReason: context.invoice.billing_reason ?? null,
        amountPaid: context.invoice.amount_paid ?? null,
        currency: context.invoice.currency ?? null,
        detail: error.message,
        lines: context.lines ?? [],
        action: 'payment_recorded_entitlement_requires_recovery',
      }),
    );
    return error;
  }

  /**
   * Grants the single paid fixed-duration service period on `invoice` as one immutable
   * MembershipEntitlementCycle. Idempotent per Stripe invoice; never touches Stripe.
   * Throws FixedDurationEntitlementError (→ HTTP 500 → Stripe retry → visible dead letter) when
   * a paid invoice cannot be turned into an entitlement, so it can never look silently healthy.
   */
  private async grantFixedDurationCycleForPaidInvoice(
    ctx: InvoiceContext,
    invoice: WebhookInvoicePayload,
    stripeEventId?: string,
  ): Promise<void> {
    if (!ctx.dbSubscriptionId) {
      const plan = ctx.membershipPlanId
        ? await this.prisma.membershipPlan.findUnique({ where: { id: ctx.membershipPlanId } })
        : null;
      if (plan?.entitlementDays) {
        // Retryable: invoice.paid can race ahead of customer.subscription.created.
        throw this.entitlementFailure(
          new FixedDurationEntitlementError(
            'SUBSCRIPTION_NOT_LOCAL',
            invoice.id,
            'paid fixed-duration invoice arrived before its local subscription; Stripe will retry',
          ),
          { stripeEventId, invoice },
        );
      }
      return;
    }

    const subscription = await this.loadFixedDurationSubscription(ctx.dbSubscriptionId);
    if (!subscription) {
      // Not a fixed-duration membership locally — unless a plan change INTO one has not synced yet.
      await this.assertNoUnsyncedFixedDurationSwitch(ctx, invoice, stripeEventId);
      return;
    }

    const decision = this.classifyForSubscription(invoice, subscription);
    if (decision.kind === 'skip') {
      this.logger.warn(
        JSON.stringify({
          event: 'fixed_duration_entitlement_not_granted',
          reason: decision.reason,
          detail: decision.detail,
          stripeEventId: stripeEventId ?? null,
          stripeInvoiceId: invoice.id,
          localSubscriptionId: subscription.id,
          billingReason: invoice.billing_reason ?? null,
          amountPaid: invoice.amount_paid ?? null,
        }),
      );
      return;
    }
    if (decision.kind === 'review') {
      throw this.entitlementFailure(
        new FixedDurationEntitlementError(decision.code, invoice.id, decision.detail),
        { stripeEventId, invoice, subscription, lines: decision.lines },
      );
    }

    if (decision.priceMatch === 'subscription_metadata') {
      // Matched only through checkout metadata: make sure the billed Price/Product is not another
      // plan's (a plan switch whose customer.subscription.updated has not landed yet).
      const otherPlan = await this.prisma.membershipPlan.findFirst({
        where: {
          studioId: subscription.studioId,
          id: { not: subscription.membershipPlanId },
          deletedAt: null,
          OR: [
            ...(decision.line.priceId ? [{ stripePriceId: decision.line.priceId }] : []),
            ...(decision.line.productId ? [{ stripeProductId: decision.line.productId }] : []),
          ],
        },
        select: { id: true },
      });
      if (otherPlan) {
        throw this.entitlementFailure(
          new FixedDurationEntitlementError(
            'SUBSCRIPTION_PLAN_NOT_SYNCED',
            invoice.id,
            `billed Price ${decision.line.priceId ?? 'none'} belongs to plan ${otherPlan.id}, not local plan ${subscription.membershipPlanId}; Stripe will retry`,
          ),
          { stripeEventId, invoice, subscription, lines: decision.lines },
        );
      }
    }

    const candidate = buildPaidFixedEntitlementCycle({
      periodStart: decision.periodStart,
      periodEnd: decision.periodEnd,
      entitlementDays: subscription.membershipPlan.entitlementDays as number,
      creditLimit: decision.creditLimit,
    });

    const outcome = await this.prisma.$transaction(async (tx) => {
      // The member-scoped lock every subscription writer takes (webhook upserts, cash sales):
      // a concurrent customer.subscription.* event can no longer re-pin the period to the
      // previous cycle after this grant commits. The subscription-scoped lock serialises cycle
      // grants exactly like the ledger trigger does.
      await acquireSubscriptionWriteAdvisoryLock(tx, subscription.studioId, subscription.userId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${subscription.id}))`;

      // Re-read under the locks: the classification above used a pre-lock snapshot.
      const current = await tx.subscription.findUnique({
        where: { id: subscription.id },
        select: { status: true, membershipPlanId: true, supersededBySubscriptionId: true, endReason: true },
      });
      if (!current || current.membershipPlanId !== subscription.membershipPlanId) {
        return { action: 'plan_changed' as const };
      }
      // A row already replaced by another subscription (e.g. a Stripe→cash transition) must not
      // silently gain a second paid entitlement next to its successor: a human decides.
      const superseded =
        current.supersededBySubscriptionId !== null ||
        current.endReason === SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD ||
        current.endReason === SubscriptionEndReason.SUPERSEDED_RENEWAL ||
        current.endReason === SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE;
      if (superseded) return { action: 'superseded' as const };

      const existingForInvoice = await tx.membershipEntitlementCycle.findUnique({
        where: { stripeInvoiceId: invoice.id },
        select: CYCLE_SELECT,
      });
      const existingForSubscription = await tx.membershipEntitlementCycle.findMany({
        where: { subscriptionId: subscription.id },
        select: CYCLE_SELECT,
        orderBy: { startsAt: 'asc' },
      });
      const plan = planPaidCycleInsertion({
        subscriptionId: subscription.id,
        candidate,
        existingForInvoice,
        existingForSubscription,
      });
      if (plan.action !== 'insert') return plan;

      await tx.membershipEntitlementCycle.create({
        data: {
          studioId: subscription.studioId,
          userId: subscription.userId,
          subscriptionId: subscription.id,
          membershipPlanId: subscription.membershipPlanId,
          startsAt: plan.cycle.startsAt,
          endsAt: plan.cycle.endsAt,
          creditLimit: plan.cycle.creditLimit,
          source: subscription.source,
          stripeInvoiceId: invoice.id,
        },
      });
      if (plan.mode === 'live') {
        // A paid period re-activates a renewable row but never resurrects a CANCELED one
        // (CANCELED + entitlementEndsAt still grants access until the paid period ends). A
        // historical gap fill never moves the current period.
        const reactivate = RENEWABLE_SUBSCRIPTION_STATUSES.includes(current.status);
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            ...(reactivate ? { status: SubscriptionStatus.ACTIVE } : {}),
            currentPeriodStart: plan.cycle.startsAt,
            currentPeriodEnd: plan.cycle.endsAt,
            entitlementEndsAt: plan.cycle.endsAt,
          },
        });
      }
      return plan;
    });

    if (outcome.action === 'plan_changed') {
      throw this.entitlementFailure(
        new FixedDurationEntitlementError(
          'SUBSCRIPTION_PLAN_NOT_SYNCED',
          invoice.id,
          `local subscription ${subscription.id} changed plan while the grant was being prepared; Stripe will retry`,
        ),
        { stripeEventId, invoice, subscription, lines: decision.lines },
      );
    }
    if (outcome.action === 'superseded') {
      throw this.entitlementFailure(
        new FixedDurationEntitlementError(
          'SUBSCRIPTION_SUPERSEDED',
          invoice.id,
          `local subscription ${subscription.id} was already superseded; refusing to add a paid period next to its successor`,
        ),
        { stripeEventId, invoice, subscription, lines: decision.lines },
      );
    }
    if (outcome.action === 'reject') {
      throw this.entitlementFailure(
        new FixedDurationEntitlementError(
          outcome.code,
          invoice.id,
          `paid period ${candidate.startsAt.toISOString()}..${candidate.endsAt.toISOString()} collides with cycle ${outcome.conflicting.id} (${outcome.conflicting.startsAt.toISOString()}..${outcome.conflicting.endsAt.toISOString()}, invoice ${outcome.conflicting.stripeInvoiceId ?? 'none'})`,
        ),
        { stripeEventId, invoice, subscription, lines: decision.lines },
      );
    }

    this.logger.log(
      JSON.stringify({
        event: 'fixed_duration_entitlement_granted',
        outcome: outcome.action === 'insert' ? outcome.mode : outcome.action,
        stripeEventId: stripeEventId ?? null,
        stripeInvoiceId: invoice.id,
        localSubscriptionId: subscription.id,
        startsAt: candidate.startsAt.toISOString(),
        endsAt: candidate.endsAt.toISOString(),
        creditLimit: candidate.creditLimit,
        priceMatch: decision.priceMatch,
      }),
    );
  }

  private async onInvoicePaymentFailed(invoice: WebhookInvoicePayload): Promise<void> {
    const ctx = await this.resolveInvoiceContext(invoice);
    if (!ctx) {
      this.logger.warn(`invoice.payment_failed ${invoice.id} could not resolve context; skipping payment row`);
      return;
    }

    // Out-of-order / concurrent delivery: a failure must never overwrite a payment Stripe has
    // settled (nor demote the membership it paid for). The FAILED write is conditional at the
    // database level, so a SUCCEEDED row committed concurrently always wins.
    const amountCents = invoice.amount_due ?? invoice.total ?? 0;
    const piId =
      typeof invoice.payment_intent === 'string'
        ? invoice.payment_intent
        : invoice.payment_intent && typeof invoice.payment_intent !== 'string'
          ? invoice.payment_intent.id
          : null;
    const currency = (invoice.currency ?? 'usd').toLowerCase();

    let failureRecorded = false;
    const updated = await this.prisma.payment.updateMany({
      where: { stripeInvoiceId: invoice.id, status: { not: PaymentStatus.SUCCEEDED } },
      data: {
        status: PaymentStatus.FAILED,
        paymentMethod: PaymentMethod.STRIPE,
        amountCents,
        currency,
        stripePaymentIntentId: piId ?? undefined,
        subscriptionId: ctx.dbSubscriptionId ?? undefined,
        membershipPlanId: ctx.membershipPlanId ?? undefined,
      },
    });
    if (updated.count > 0) {
      failureRecorded = true;
    } else {
      const existing = await this.prisma.payment.findUnique({
        where: { stripeInvoiceId: invoice.id },
        select: { status: true },
      });
      if (!existing) {
        try {
          await this.prisma.payment.create({
            data: {
              studioId: ctx.studioId,
              userId: ctx.userId,
              subscriptionId: ctx.dbSubscriptionId,
              membershipPlanId: ctx.membershipPlanId,
              amountCents,
              currency,
              status: PaymentStatus.FAILED,
              paymentMethod: PaymentMethod.STRIPE,
              stripeInvoiceId: invoice.id,
              stripePaymentIntentId: piId,
            },
          });
          failureRecorded = true;
        } catch (err) {
          // A concurrent writer (typically invoice.paid) created the row first: it wins.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
        }
      }
    }
    if (!failureRecorded) {
      this.logger.warn(
        JSON.stringify({
          event: 'invoice_payment_failed_ignored_already_paid',
          stripeInvoiceId: invoice.id,
          localSubscriptionId: ctx.dbSubscriptionId,
        }),
      );
      return;
    }

    if (ctx.dbSubscriptionId) {
      // Only a renewable row can become PAST_DUE. customer.subscription.* events carry the
      // authoritative lifecycle; a failure delivered after Stripe cancelled the subscription
      // (seen in production 2026-09-28) must not resurrect it. One conditional statement, so a
      // concurrent invoice.paid that already settled this invoice always wins.
      const demoted = await this.prisma.subscription.updateMany({
        where: {
          id: ctx.dbSubscriptionId,
          status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
          payments: { none: { stripeInvoiceId: invoice.id, status: PaymentStatus.SUCCEEDED } },
        },
        data: { status: SubscriptionStatus.PAST_DUE },
      });
      if (demoted.count === 0) {
        this.logger.log(
          JSON.stringify({
            event: 'invoice_payment_failed_status_preserved',
            stripeInvoiceId: invoice.id,
            localSubscriptionId: ctx.dbSubscriptionId,
          }),
        );
      }
    }
  }

  /**
   * Day Pass activation. The event type is the authority that the intent succeeded; all
   * ownership/idempotency rules live in day-pass-activation.ts so the API's server-side
   * retrieval path and this webhook can never disagree.
   */
  private async onPaymentIntentSucceeded(
    paymentIntent: WebhookPaymentIntentPayload,
    eventId: string,
  ): Promise<void> {
    const md = paymentIntent.metadata;
    if (!md || md['type'] !== 'day_pass') {
      return;
    }
    const outcome = await activateDayPassFromSucceededPaymentIntent(
      this.prisma,
      this.logger,
      {
        id: paymentIntent.id,
        status: 'succeeded',
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        created: paymentIntent.created ?? null,
        metadata: md,
      },
      'webhook',
      eventId,
    );
    if (outcome.outcome === 'activated' && outcome.supersededIntentId) {
      // The paid intent had been replaced; the unpaid replacement must not stay payable.
      try {
        await this.stripe.cancelPaymentIntent(outcome.supersededIntentId, 'duplicate');
      } catch (err) {
        this.logger.warn(
          `Day Pass: could not cancel superseded PaymentIntent ${outcome.supersededIntentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * payment_intent.payment_failed / payment_intent.canceled for a Day Pass attempt.
   * Neither is a terminal state for the SLOT: the member may retry, and the API decides on
   * the next attempt (live Stripe status) whether to re-present or replace the intent. Here we
   * only cache what Stripe said, and only for the slot's CURRENT intent — a replaced intent's
   * late failure must not overwrite the telemetry of the attempt that superseded it. An
   * ACTIVE slot is never downgraded (out-of-order delivery after a success).
   */
  private async onPaymentIntentNotSucceeded(
    paymentIntent: WebhookPaymentIntentPayload,
    eventType: string,
    eventId: string,
  ): Promise<void> {
    const md = paymentIntent.metadata;
    if (!md || md['type'] !== 'day_pass') {
      return;
    }
    const canceled = eventType === 'payment_intent.canceled';
    const eventName = canceled ? 'DAY_PASS_PAYMENT_CANCELED' : 'DAY_PASS_PAYMENT_FAILED';
    const dayPassId = md['dayPassId'] ?? null;
    const base = {
      dayPassId,
      studioId: md['studioId'] ?? null,
      userId: md['userId'] ?? null,
      stripePaymentIntentId: paymentIntent.id,
      eventId,
      source: 'webhook' as const,
    };
    if (!dayPassId) {
      logDayPassEvent(this.logger, 'DAY_PASS_WEBHOOK_IGNORED', { ...base, reason: 'metadata_incomplete' }, 'warn');
      return;
    }

    const dayPass = await this.prisma.dayPass.findUnique({
      where: { id: dayPassId },
      select: { id: true, studioId: true, userId: true, status: true, stripePaymentIntentId: true },
    });
    if (!dayPass) {
      logDayPassEvent(this.logger, 'DAY_PASS_WEBHOOK_IGNORED', { ...base, reason: 'day_pass_not_found' }, 'warn');
      return;
    }
    if (dayPass.studioId !== md['studioId'] || dayPass.userId !== md['userId']) {
      logDayPassEvent(this.logger, 'DAY_PASS_WEBHOOK_IGNORED', { ...base, reason: 'tenant_mismatch' }, 'warn');
      return;
    }
    if (dayPass.stripePaymentIntentId !== paymentIntent.id) {
      logDayPassEvent(this.logger, 'DAY_PASS_WEBHOOK_IGNORED', {
        ...base,
        reason: 'stale_intent',
        currentIntent: dayPass.stripePaymentIntentId,
      });
      return;
    }
    if (dayPass.status === DayPassStatus.ACTIVE || dayPass.status === DayPassStatus.REFUNDED) {
      logDayPassEvent(this.logger, 'DAY_PASS_WEBHOOK_IGNORED', { ...base, reason: `slot_${dayPass.status.toLowerCase()}` });
      return;
    }

    const errorCode = paymentIntent.last_payment_error?.code ?? null;
    const declineCode = paymentIntent.last_payment_error?.decline_code ?? null;
    await this.prisma.dayPass.updateMany({
      where: { id: dayPassId, stripePaymentIntentId: paymentIntent.id, status: { not: DayPassStatus.ACTIVE } },
      data: {
        lastStripeStatus: canceled ? 'canceled' : paymentIntent.status || 'requires_payment_method',
        ...(canceled ? {} : { lastPaymentErrorCode: errorCode, lastPaymentDeclineCode: declineCode }),
      },
    });
    logDayPassEvent(this.logger, eventName, {
      ...base,
      stripeStatus: canceled ? 'canceled' : paymentIntent.status,
      errorCode,
      declineCode,
      reason: canceled ? paymentIntent.cancellation_reason ?? null : null,
    });
  }
}
