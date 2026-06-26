import { Injectable, Logger } from '@nestjs/common';
import { DayPassStatus, PaymentStatus, Prisma, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { markStripeWebhookEventProcessed, tryClaimStripeWebhookEvent } from './stripe-webhook-idempotency';
import {
  type WebhookCheckoutSessionPayload,
  type WebhookInvoicePayload,
  type WebhookPaymentIntentPayload,
  type WebhookSubscriptionPayload,
} from './stripe-webhook-payloads';
import { mapStripeSubscriptionStatus } from './stripe-subscription-status';

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
      throw err;
    }
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
        await this.onCustomerSubscription(event.data.object as WebhookSubscriptionPayload);
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
    await this.upsertSubscriptionFromStripe(stripeSub, md);

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

  private async onCustomerSubscription(subscription: WebhookSubscriptionPayload): Promise<void> {
    const md = readTriplet(subscription.metadata);
    await this.upsertSubscriptionFromStripe(subscription, md);
  }

  private async upsertSubscriptionFromStripe(
    sub: WebhookSubscriptionPayload,
    sessionOrRootMetadata: { userId?: string; studioId?: string; planId?: string },
  ): Promise<void> {
    const md = { ...readTriplet(sub.metadata), ...sessionOrRootMetadata };

    // Resolve userId: from metadata → Stripe customer lookup
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

    // Resolve studioId + planId from metadata, fallback to stripePriceId lookup
    let studioId = md.studioId ?? null;
    let planId = md.planId ?? null;

    if ((!planId || !studioId) && sub.items?.data.length) {
      const stripePriceId = sub.items.data[0]?.price?.id ?? null;
      if (stripePriceId) {
        const byPrice = await this.prisma.membershipPlan.findFirst({
          where: { stripePriceId, deletedAt: null },
        });
        if (byPrice) {
          planId = planId ?? byPrice.id;
          studioId = studioId ?? byPrice.studioId;
        }
      }
    }

    if (!userId || !studioId || !planId) {
      this.logger.warn(`Subscription ${sub.id} missing metadata; skipping DB upsert`);
      return;
    }

    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: planId, studioId, deletedAt: null },
    });
    if (!plan) {
      this.logger.warn(`Plan ${planId} not found for studio ${studioId}; skipping subscription upsert`);
      return;
    }

    const status = mapStripeSubscriptionStatus(sub.status);

    // Billing period from subscription.items.data[0] — the canonical source in
    // Stripe's basil API (2025-08-27.basil) which removed root-level period fields.
    const currentPeriodStart = parseStripePeriodDate(sub.items?.data?.[0]?.current_period_start);
    const currentPeriodEnd   = parseStripePeriodDate(sub.items?.data?.[0]?.current_period_end);
    const periodData =
      currentPeriodStart &&
      currentPeriodEnd &&
      currentPeriodStart.getTime() !== currentPeriodEnd.getTime()
        ? { currentPeriodStart, currentPeriodEnd }
        : {};

    await this.prisma.subscription.upsert({
      where: { stripeSubscriptionId: sub.id },
      create: {
        studioId,
        userId,
        membershipPlanId: planId,
        status,
        stripeSubscriptionId: sub.id,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        ...periodData,
      },
      update: {
        status,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        membershipPlanId: planId,
        ...periodData,
      },
    });
  }

  /**
   * Resolves userId, studioId, DB subscriptionId, and membershipPlanId from an invoice.
   * Prefers DB lookup (avoids extra Stripe API call); falls back to retrieveSubscription metadata.
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

    const stripeSubId =
      typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription && typeof invoice.subscription !== 'string'
          ? invoice.subscription.id
          : null;

    // Try DB first to avoid an extra Stripe API call
    if (stripeSubId) {
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
      // Fallback: retrieve from Stripe to get metadata
      const stripeSub = (await this.stripe.retrieveSubscription(
        stripeSubId,
      )) as unknown as WebhookSubscriptionPayload;
      const studioId = readTriplet(stripeSub.metadata).studioId;
      if (!studioId) return null;
      return { userId: user.id, studioId, dbSubscriptionId: null, membershipPlanId: null };
    }

    return null;
  }

  private async onInvoicePaid(invoice: WebhookInvoicePayload): Promise<void> {
    if (invoice.status !== 'paid') {
      return;
    }
    const ctx = await this.resolveInvoiceContext(invoice);
    if (!ctx) {
      this.logger.warn(`invoice.paid ${invoice.id} could not resolve context; skipping payment row`);
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
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: piId,
        paidAt,
      },
      update: {
        status: PaymentStatus.SUCCEEDED,
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
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: piId,
      },
      update: {
        status: PaymentStatus.FAILED,
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
