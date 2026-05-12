import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus, Prisma, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { markStripeWebhookEventProcessed, tryClaimStripeWebhookEvent } from './stripe-webhook-idempotency';
import {
  type WebhookCheckoutSessionPayload,
  type WebhookInvoicePayload,
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
    let userId = md.userId ?? null;
    if (!userId && typeof sub.customer === 'string') {
      const user = await this.prisma.user.findFirst({
        where: { stripeCustomerId: sub.customer, deletedAt: null },
      });
      userId = user?.id ?? null;
    } else if (!userId && sub.customer && typeof sub.customer !== 'string') {
      const user = await this.prisma.user.findFirst({
        where: { stripeCustomerId: sub.customer.id, deletedAt: null },
      });
      userId = user?.id ?? null;
    }
    const studioId = md.studioId ?? null;
    const planId = md.planId ?? null;
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

    const currentPeriodStart = sub.current_period_start
      ? new Date(sub.current_period_start * 1000)
      : null;
    const currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;

    await this.prisma.subscription.upsert({
      where: { stripeSubscriptionId: sub.id },
      create: {
        studioId,
        userId,
        membershipPlanId: planId,
        status,
        stripeSubscriptionId: sub.id,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      },
      update: {
        status,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        membershipPlanId: planId,
      },
    });
  }

  private async onInvoicePaid(invoice: WebhookInvoicePayload): Promise<void> {
    if (invoice.status !== 'paid') {
      return;
    }
    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
    if (!customerId) {
      return;
    }
    const user = await this.prisma.user.findFirst({
      where: { stripeCustomerId: customerId, deletedAt: null },
    });
    if (!user) {
      return;
    }

    const subscriptionId =
      typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription && typeof invoice.subscription !== 'string'
          ? invoice.subscription.id
          : null;

    let studioId: string | undefined;
    if (subscriptionId) {
      const stripeSub = (await this.stripe.retrieveSubscription(
        subscriptionId,
      )) as unknown as WebhookSubscriptionPayload;
      studioId = readTriplet(stripeSub.metadata).studioId;
    }
    if (!studioId) {
      this.logger.warn(`invoice.paid ${invoice.id} could not resolve studioId; skipping payment row`);
      return;
    }

    const amountCents = invoice.amount_paid ?? 0;
    const piId =
      typeof invoice.payment_intent === 'string'
        ? invoice.payment_intent
        : invoice.payment_intent && typeof invoice.payment_intent !== 'string'
          ? invoice.payment_intent.id
          : null;

    await this.prisma.payment.upsert({
      where: { stripeInvoiceId: invoice.id },
      create: {
        studioId,
        userId: user.id,
        amountCents,
        currency: (invoice.currency ?? 'usd').toLowerCase(),
        status: PaymentStatus.SUCCEEDED,
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: piId,
      },
      update: {
        status: PaymentStatus.SUCCEEDED,
        amountCents,
        currency: (invoice.currency ?? 'usd').toLowerCase(),
        stripePaymentIntentId: piId ?? undefined,
      },
    });
  }

  private async onInvoicePaymentFailed(invoice: WebhookInvoicePayload): Promise<void> {
    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
    if (!customerId) {
      return;
    }
    const user = await this.prisma.user.findFirst({
      where: { stripeCustomerId: customerId, deletedAt: null },
    });
    if (!user) {
      return;
    }

    const subscriptionId =
      typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription && typeof invoice.subscription !== 'string'
          ? invoice.subscription.id
          : null;

    let studioId: string | undefined;
    if (subscriptionId) {
      const stripeSub = (await this.stripe.retrieveSubscription(
        subscriptionId,
      )) as unknown as WebhookSubscriptionPayload;
      studioId = readTriplet(stripeSub.metadata).studioId;
    }
    if (!studioId) {
      this.logger.warn(`invoice.payment_failed ${invoice.id} could not resolve studioId; skipping payment row`);
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
        studioId,
        userId: user.id,
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
      },
    });

    if (subscriptionId) {
      await this.prisma.subscription.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: { status: SubscriptionStatus.PAST_DUE },
      });
    }
  }
}
