import { Injectable, Logger } from '@nestjs/common';
import { DayPassStatus, PaymentMethod, PaymentStatus, Prisma, Subscription, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { RENEWABLE_SUBSCRIPTION_STATUSES } from './subscription-lifecycle.constants';
import { subscriptionLockKey } from './subscription-lifecycle.utils';
import {
  readCurrentStripePriceId,
  readPendingPlanIdFromMetadata,
} from './subscription-plan-resolution.utils';
import { markStripeWebhookEventProcessed, tryClaimStripeWebhookEvent } from './stripe-webhook-idempotency';
import {
  type WebhookCheckoutSessionPayload,
  type WebhookInvoicePayload,
  type WebhookPaymentIntentPayload,
  type WebhookSubscriptionPayload,
} from './stripe-webhook-payloads';
import { mapStripeSubscriptionStatus } from './stripe-subscription-status';
import { readInvoiceSubscriptionId } from './stripe-invoice.utils';

type VerifiedStripeEvent = {
  id: string;
  type: string;
  data: { object: unknown };
};

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
  ) {}

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
          event.type,
        );
        break;
      case 'invoice.paid':
        await this.onInvoicePaid(event.data.object as WebhookInvoicePayload);
        break;
      case 'invoice.payment_failed':
        await this.onInvoicePaymentFailed(event.data.object as WebhookInvoicePayload);
        break;
      case 'payment_intent.succeeded':
        await this.onPaymentIntentSucceeded(event.data.object as WebhookPaymentIntentPayload);
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
    stripeEventType: string,
  ): Promise<void> {
    const md = readTriplet(subscription.metadata);
    await this.upsertSubscriptionFromStripe(subscription, md, stripeEventType);
  }

  private async upsertSubscriptionFromStripe(
    sub: WebhookSubscriptionPayload,
    sessionOrRootMetadata: { userId?: string; studioId?: string; planId?: string },
    stripeEventType: string,
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

    // Captured inside the transaction and read after it commits.
    let planEntitlementDays: number | null = null;

    const saved = await this.prisma.$transaction(async (tx) => {
      // Serialise concurrent webhook deliveries for the same member/studio, preventing
      // races where two deliveries both pass the conflict check and both try to CREATE.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${subscriptionLockKey(studioId, userId)}))`;

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
        },
      });
      if (!plan) {
        this.logger.warn(
          `Plan ${membershipPlanId} not found for studio ${studioId}; skipping subscription upsert`,
        );
        return null;
      }
      // Capture for post-transaction Stripe auto-cancel logic.
      planEntitlementDays = plan.entitlementDays ?? null;

      // For fixed-duration plans (entitlementDays set), compute the GymOS entitlement end
      // from the Stripe period start. This is set ONLY on CREATE and never overwritten on
      // subsequent webhooks — billing renewal and access window are deliberately decoupled.
      const entitlementEndsAt =
        plan.entitlementDays != null && currentPeriodStart
          ? new Date(currentPeriodStart.getTime() + plan.entitlementDays * 86_400_000)
          : undefined;

      // Guard against violating the partial unique index on (studio_id, user_id) WHERE status='ACTIVE'.
      // Only the CREATE branch of upsert can conflict; the UPDATE branch targets the existing row by
      // stripeSubscriptionId and never inserts a second ACTIVE row.
      if (RENEWABLE_SUBSCRIPTION_STATUSES.includes(status)) {
        const existingRowForThisSub = await tx.subscription.findUnique({
          where: { stripeSubscriptionId: sub.id },
        });
        if (!existingRowForThisSub) {
          const conflictingRow = await tx.subscription.findFirst({
            where: { studioId, userId, status: { in: RENEWABLE_SUBSCRIPTION_STATUSES } },
          });
          if (conflictingRow) {
            return this.handleWebhookActiveConflict(tx, {
              conflictingRow,
              incomingSub: sub,
              incomingStatus: status,
              incomingMembershipPlanId: membershipPlanId,
              incomingPendingMembershipPlanId: pendingMembershipPlanId,
              incomingPeriodData: periodData,
              entitlementEndsAt,
              studioId,
              userId,
              stripeEventType,
            });
          }
        }
      }

      const row = await tx.subscription.upsert({
        where: { stripeSubscriptionId: sub.id },
        create: {
          studioId,
          userId,
          membershipPlanId,
          pendingMembershipPlanId,
          status,
          stripeSubscriptionId: sub.id,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          ...periodData,
          // entitlementEndsAt is set only at creation — decoupled from Stripe period updates
          ...(entitlementEndsAt !== undefined ? { entitlementEndsAt } : {}),
        },
        update: {
          status,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          membershipPlanId,
          pendingMembershipPlanId,
          ...periodData,
          // entitlementEndsAt deliberately omitted from update — never overwritten by Stripe
        },
      });

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

      return row;
    });

    if (!saved) return;

    // For fixed-duration plans (entitlementDays set), automatically prevent Stripe from
    // charging for an unintended renewal at the end of the billing period. This runs after
    // the DB transaction so a Stripe API failure doesn't roll back the local subscription row.
    // Idempotent: if cancelAtPeriodEnd is already true on the Stripe object, this is a no-op.
    if (
      planEntitlementDays != null &&
      RENEWABLE_SUBSCRIPTION_STATUSES.includes(status) &&
      !sub.cancel_at_period_end
    ) {
      try {
        await this.stripe.updateSubscription(sub.id, { cancel_at_period_end: true });
        await this.prisma.subscription.update({
          where: { id: saved.id },
          data: { cancelAtPeriodEnd: true },
        });
        this.logger.log(
          JSON.stringify({
            event: 'fixed_duration_plan_auto_cancel_set',
            stripeSubscriptionId: sub.id,
            subscriptionId: saved.id,
            entitlementDays: planEntitlementDays,
          }),
        );
      } catch (e) {
        // Log and continue — the local subscription row is already committed. The next
        // webhook delivery will retry because cancelAtPeriodEnd will still be false on Stripe.
        this.logger.error(
          JSON.stringify({
            event: 'fixed_duration_plan_auto_cancel_failed',
            stripeSubscriptionId: sub.id,
            error: String(e),
          }),
        );
      }
    }

    if (
      readPendingPlanIdFromMetadata(sub.metadata) &&
      saved.pendingMembershipPlanId &&
      saved.membershipPlanId !== saved.pendingMembershipPlanId
    ) {
      this.logger.log(
        JSON.stringify({
          event: 'scheduled_plan_change_pending',
          stripeSubscriptionId: sub.id,
          effectivePlanId: saved.membershipPlanId,
          pendingPlanId: saved.pendingMembershipPlanId,
          currentPeriodEnd: saved.currentPeriodEnd?.toISOString() ?? null,
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
      await tx.subscription.update({
        where: { id: conflictingRow.id },
        data: { status: SubscriptionStatus.CANCELED },
      });
      this.logger.log(
        JSON.stringify({
          event: 'webhook_superseded_expired_cash_subscription',
          canceledLocalId: conflictingRow.id,
          incomingStripeSubId: incomingSub.id,
          stripeEventType,
          studioId,
          userId,
        }),
      );
      return tx.subscription.create({
        data: {
          studioId,
          userId,
          membershipPlanId: params.incomingMembershipPlanId,
          pendingMembershipPlanId: params.incomingPendingMembershipPlanId,
          status: params.incomingStatus,
          stripeSubscriptionId: incomingSub.id,
          cancelAtPeriodEnd: incomingSub.cancel_at_period_end,
          ...params.incomingPeriodData,
          ...(params.entitlementEndsAt !== undefined ? { entitlementEndsAt: params.entitlementEndsAt } : {}),
        },
      });
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

  private async onInvoicePaid(invoice: WebhookInvoicePayload): Promise<void> {
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
    const piId =
      typeof invoice.payment_intent === 'string'
        ? invoice.payment_intent
        : invoice.payment_intent && typeof invoice.payment_intent !== 'string'
          ? invoice.payment_intent.id
          : null;
    const paidAt = invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000)
      : new Date();

    // Keyed by stripeInvoiceId — idempotent on Stripe retries
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
  }

  private async onInvoicePaymentFailed(invoice: WebhookInvoicePayload): Promise<void> {
    const ctx = await this.resolveInvoiceContext(invoice);
    if (!ctx) {
      this.logger.warn(`invoice.payment_failed ${invoice.id} could not resolve context; skipping payment row`);
      return;
    }

    const amountCents = invoice.amount_due ?? invoice.total ?? 0;
    const piId =
      typeof invoice.payment_intent === 'string'
        ? invoice.payment_intent
        : invoice.payment_intent && typeof invoice.payment_intent !== 'string'
          ? invoice.payment_intent.id
          : null;

    await this.prisma.payment.upsert({
      where: { stripeInvoiceId: invoice.id },
      create: {
        studioId: ctx.studioId,
        userId: ctx.userId,
        subscriptionId: ctx.dbSubscriptionId,
        membershipPlanId: ctx.membershipPlanId,
        amountCents,
        currency: (invoice.currency ?? 'usd').toLowerCase(),
        status: PaymentStatus.FAILED,
        paymentMethod: PaymentMethod.STRIPE,
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: piId,
      },
      update: {
        status: PaymentStatus.FAILED,
        paymentMethod: PaymentMethod.STRIPE,
        amountCents,
        currency: (invoice.currency ?? 'usd').toLowerCase(),
        stripePaymentIntentId: piId ?? undefined,
        subscriptionId: ctx.dbSubscriptionId ?? undefined,
        membershipPlanId: ctx.membershipPlanId ?? undefined,
      },
    });

    if (ctx.dbSubscriptionId) {
      await this.prisma.subscription.update({
        where: { id: ctx.dbSubscriptionId },
        data: { status: SubscriptionStatus.PAST_DUE },
      });
    }
  }

  private async onPaymentIntentSucceeded(paymentIntent: WebhookPaymentIntentPayload): Promise<void> {
    const md = paymentIntent.metadata;
    if (!md || md['type'] !== 'day_pass') {
      return;
    }

    const dayPassId = md['dayPassId'] ?? null;
    const studioId = md['studioId'] ?? null;
    const userId = md['userId'] ?? null;

    if (!dayPassId || !studioId || !userId) {
      this.logger.warn(
        `payment_intent.succeeded ${paymentIntent.id}: day_pass metadata incomplete; skipping`,
      );
      return;
    }

    const dayPass = await this.prisma.dayPass.findUnique({
      where: { id: dayPassId },
      select: {
        id: true,
        studioId: true,
        userId: true,
        status: true,
        priceCents: true,
        currency: true,
        stripePaymentIntentId: true,
      },
    });

    if (!dayPass) {
      this.logger.warn(
        `payment_intent.succeeded ${paymentIntent.id}: DayPass ${dayPassId} not found; skipping`,
      );
      return;
    }

    if (dayPass.studioId !== studioId || dayPass.userId !== userId) {
      this.logger.warn(
        `payment_intent.succeeded ${paymentIntent.id}: DayPass ${dayPassId} studioId/userId mismatch; ignoring`,
      );
      return;
    }

    if (dayPass.stripePaymentIntentId !== null && dayPass.stripePaymentIntentId !== paymentIntent.id) {
      this.logger.warn(
        `payment_intent.succeeded ${paymentIntent.id}: DayPass ${dayPassId} already linked to different PaymentIntent ${dayPass.stripePaymentIntentId}; ignoring`,
      );
      return;
    }

    if (dayPass.status === DayPassStatus.REFUNDED || dayPass.status === DayPassStatus.EXPIRED) {
      this.logger.warn(
        `payment_intent.succeeded ${paymentIntent.id}: DayPass ${dayPassId} has terminal status ${dayPass.status}; skipping`,
      );
      return;
    }

    // Activate only if not already ACTIVE; the Payment upsert always runs so a partial
    // failure on a prior delivery (DayPass activated but Payment not written) is repaired.
    if (dayPass.status !== DayPassStatus.ACTIVE) {
      await this.prisma.dayPass.update({
        where: { id: dayPassId },
        data: {
          status: DayPassStatus.ACTIVE,
          stripePaymentIntentId: paymentIntent.id,
        },
      });
    }

    const paidAt = paymentIntent.created ? new Date(paymentIntent.created * 1000) : new Date();

    await this.prisma.payment.upsert({
      where: { stripePaymentIntentId: paymentIntent.id },
      create: {
        studioId: dayPass.studioId,
        userId: dayPass.userId,
        amountCents: dayPass.priceCents,
        currency: dayPass.currency.toLowerCase(),
        status: PaymentStatus.SUCCEEDED,
        stripePaymentIntentId: paymentIntent.id,
        paidAt,
      },
      update: {
        status: PaymentStatus.SUCCEEDED,
        paidAt,
      },
    });
  }
}
