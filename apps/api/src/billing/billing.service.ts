import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BillingInterval } from '@prisma/client';
import { Role } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { WaiverService } from '../waiver/waiver.service';
import { billingIntervalToStripeRecurring, stripeIntervalToBillingInterval } from './stripe-plan-interval';
import {
  SubscriptionLifecycleService,
  type MembershipCheckoutResponse,
} from './subscription-lifecycle.service';

export type { MembershipCheckoutResponse };

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly config: ConfigService,
    private readonly enrollment: EnrollmentService,
    private readonly waiverService: WaiverService,
    private readonly subscriptionLifecycle: SubscriptionLifecycleService,
  ) {}

  async createMemberCheckoutSession(params: {
    userId: string;
    studioId: string;
    planId: string;
    idempotencyKey?: string;
  }): Promise<MembershipCheckoutResponse> {
    await this.waiverService.assertMemberWaiverAccepted(params.studioId, params.userId);
    return this.initiateMembershipPurchase(params);
  }

  async createStaffInitiatedCheckoutSession(params: {
    actorUserId: string;
    targetUserId: string;
    studioId: string;
    planId: string;
    idempotencyKey?: string;
  }): Promise<MembershipCheckoutResponse> {
    return this.initiateMembershipPurchase({
      userId: params.targetUserId,
      studioId: params.studioId,
      planId: params.planId,
      initiatedByUserId: params.actorUserId,
      idempotencyKey: params.idempotencyKey,
    });
  }

  async getPlanChangePreview(params: {
    userId: string;
    studioId: string;
    planId: string;
  }) {
    return this.subscriptionLifecycle.getPlanChangePreview({
      userId: params.userId,
      studioId: params.studioId,
      targetPlanId: params.planId,
    });
  }

  private async initiateMembershipPurchase(params: {
    userId: string;
    studioId: string;
    planId: string;
    initiatedByUserId?: string;
    idempotencyKey?: string;
  }): Promise<MembershipCheckoutResponse> {
    const { priceId } = await this.ensureMembershipPlanStripePrice(params.planId);
    const idempotencyKey =
      params.idempotencyKey ??
      createHash('sha256')
        .update(`${params.studioId}:${params.userId}:${params.planId}:${params.initiatedByUserId ?? 'self'}`)
        .digest('hex')
        .slice(0, 32);

    return this.subscriptionLifecycle.initiateMembershipPurchase({
      targetUserId: params.userId,
      studioId: params.studioId,
      planId: params.planId,
      newStripePriceId: priceId,
      initiatedByUserId: params.initiatedByUserId,
      idempotencyKey,
      createCheckout: async (ctx) =>
        this.buildMemberCheckoutSession({
          targetUserId: ctx.targetUserId,
          studioId: ctx.studioId,
          planId: ctx.planId,
          initiatedByUserId: ctx.initiatedByUserId,
          idempotencyKey: ctx.idempotencyKey,
        }),
    });
  }

  private async buildMemberCheckoutSession(params: {
    targetUserId: string;
    studioId: string;
    planId: string;
    initiatedByUserId?: string;
    idempotencyKey?: string;
  }): Promise<{ checkoutUrl: string }> {
    const membership = await this.prisma.studioMembership.findUnique({
      where: { userId_studioId: { userId: params.targetUserId, studioId: params.studioId } },
      include: { user: true },
    });
    if (!membership || membership.deletedAt) {
      throw new ForbiddenException('Not a member of this studio');
    }
    if (membership.role !== Role.MEMBER) {
      throw new ForbiddenException('Checkout is available to studio members with the MEMBER role only');
    }

    const existingStripe = await this.subscriptionLifecycle.findPrimaryStripeSubscription(
      params.studioId,
      params.targetUserId,
    );
    if (existingStripe?.stripeSubscriptionId) {
      throw new BadRequestException(
        'Member already has a Stripe subscription. Use plan change instead of creating a new checkout session.',
      );
    }

    const plan = await this.prisma.membershipPlan.findFirst({
      where: {
        id: params.planId,
        studioId: params.studioId,
        deletedAt: null,
        active: true,
      },
    });
    if (!plan) {
      throw new NotFoundException('Membership plan not found');
    }

    const { priceId } = await this.ensureMembershipPlanStripePrice(plan.id);

    const user = membership.user;
    if (user.deletedAt) {
      throw new ForbiddenException();
    }

    const customer = await this.stripe.createOrRetrieveCustomer({
      email: user.email,
      name: `${user.firstName} ${user.lastName}`.trim(),
      existingStripeCustomerId: user.stripeCustomerId,
      metadata: { gymosUserId: user.id },
    });

    if (customer.id !== user.stripeCustomerId) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customer.id },
      });
    }

    const successUrl = this.config.getOrThrow<string>('STRIPE_SUCCESS_URL');
    const cancelUrl = this.config.getOrThrow<string>('STRIPE_CANCEL_URL');

    const quote = await this.enrollment.calculateCheckoutQuote(
      params.targetUserId,
      params.studioId,
      params.planId,
    );

    const enrollmentMeta: Record<string, string> = {};
    let addInvoiceItems: Array<{ price: string; quantity: number }> = [];

    if (quote.enrollmentFeeApplies && quote.settingsId) {
      enrollmentMeta['enrollmentSettingsId'] = quote.settingsId;
      enrollmentMeta['enrollmentCandidate'] = quote.isPromoCandidate ? 'true' : 'false';

      if (!quote.isPromoCandidate) {
        const feePriceId = await this.enrollment.ensureEnrollmentFeeStripePrice(quote.settingsId);
        addInvoiceItems = [{ price: feePriceId, quantity: 1 }];
      }
    }

    const initiatedMeta: Record<string, string> =
      params.initiatedByUserId != null
        ? { initiatedByUserId: params.initiatedByUserId }
        : {};

    const sessionMetadata: Record<string, string> = {
      userId: user.id,
      studioId: params.studioId,
      planId: plan.id,
      ...enrollmentMeta,
      ...initiatedMeta,
    };

    const session = await this.stripe.createCheckoutSession(
      {
        mode: 'subscription',
        customer: customer.id,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: sessionMetadata,
        subscription_data: {
          metadata: {
            userId: user.id,
            studioId: params.studioId,
            planId: plan.id,
            ...initiatedMeta,
          },
          ...(addInvoiceItems.length > 0 ? { add_invoice_items: addInvoiceItems } : {}),
        },
      },
      params.idempotencyKey ? { idempotencyKey: `checkout-${params.idempotencyKey}` } : undefined,
    );

    const checkoutUrl = session.url;
    if (!checkoutUrl) {
      throw new BadRequestException('Stripe Checkout session did not return a URL');
    }
    return { checkoutUrl };
  }

  async createBillingPortalSessionForUser(params: {
    userId: string;
    studioId: string;
  }): Promise<{ url: string }> {
    const membership = await this.prisma.studioMembership.findUnique({
      where: { userId_studioId: { userId: params.userId, studioId: params.studioId } },
    });
    if (!membership || membership.deletedAt) {
      throw new ForbiddenException('Not a member of this studio');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: params.userId, deletedAt: null },
    });
    if (!user?.stripeCustomerId) {
      throw new BadRequestException('No Stripe customer on file for this account');
    }

    const returnUrl = this.config.getOrThrow<string>('STRIPE_BILLING_PORTAL_RETURN_URL');
    const portal = await this.stripe.createBillingPortalSession(user.stripeCustomerId, returnUrl);
    const url = portal.url;
    if (!url) {
      throw new BadRequestException('Stripe Billing Portal did not return a URL');
    }
    return { url };
  }

  async ensureMembershipPlanStripePrice(planId: string): Promise<{ priceId: string; productId: string }> {
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: planId, deletedAt: null, active: true },
    });
    if (!plan) {
      throw new NotFoundException('Membership plan not found');
    }

    let productId = plan.stripeProductId;
    if (!productId) {
      const product = await this.stripe.createProductForPlan({
        name: plan.name,
        metadata: { gymosPlanId: plan.id, gymosStudioId: plan.studioId },
      });
      productId = product.id;
      await this.prisma.membershipPlan.update({
        where: { id: plan.id },
        data: { stripeProductId: productId },
      });
    }

    let priceId = plan.stripePriceId;
    const needsNewPrice =
      !priceId ||
      (await this.membershipPlanPriceOutOfSync({
        planPriceCents: plan.priceCents,
        planBillingInterval: plan.billingInterval,
        planCurrency: plan.currency,
        stripePriceId: priceId,
      }));

    if (needsNewPrice) {
      const { interval } = billingIntervalToStripeRecurring(plan.billingInterval);
      const price = await this.stripe.createRecurringPrice({
        productId,
        unitAmount: plan.priceCents,
        currency: plan.currency,
        interval,
      });
      priceId = price.id;
      await this.prisma.membershipPlan.update({
        where: { id: plan.id },
        data: { stripePriceId: priceId, stripeProductId: productId },
      });
    }

    if (!productId || !priceId) {
      throw new Error('Stripe product/price sync failed to persist ids');
    }

    return { priceId, productId };
  }

  private async membershipPlanPriceOutOfSync(params: {
    planPriceCents: number;
    planBillingInterval: BillingInterval;
    planCurrency: string;
    stripePriceId: string;
  }): Promise<boolean> {
    try {
      const price = await this.stripe.retrievePrice(params.stripePriceId);
      if (price.unit_amount !== params.planPriceCents) {
        return true;
      }
      if (!price.recurring?.interval) {
        return true;
      }
      const mapped = stripeIntervalToBillingInterval(price.recurring.interval);
      if (mapped !== params.planBillingInterval) {
        return true;
      }
      if ((price.currency ?? 'usd').toLowerCase() !== params.planCurrency.toLowerCase()) {
        return true;
      }
      return false;
    } catch {
      return true;
    }
  }
}
