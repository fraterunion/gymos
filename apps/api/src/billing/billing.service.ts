import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BillingInterval } from '@prisma/client';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { billingIntervalToStripeRecurring, stripeIntervalToBillingInterval } from './stripe-plan-interval';

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly config: ConfigService,
  ) {}

  async createMemberCheckoutSession(params: {
    userId: string;
    studioId: string;
    planId: string;
  }): Promise<{ url: string }> {
    const membership = await this.prisma.studioMembership.findUnique({
      where: { userId_studioId: { userId: params.userId, studioId: params.studioId } },
      include: { user: true },
    });
    if (!membership || membership.deletedAt) {
      throw new ForbiddenException('Not a member of this studio');
    }
    if (membership.role !== Role.MEMBER) {
      throw new ForbiddenException('Checkout is available to studio members with the MEMBER role only');
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

    const session = await this.stripe.createCheckoutSession({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: user.id,
        studioId: params.studioId,
        planId: plan.id,
      },
      subscription_data: {
        metadata: {
          userId: user.id,
          studioId: params.studioId,
          planId: plan.id,
        },
      },
    });

    const url = session.url;
    if (!url) {
      throw new BadRequestException('Stripe Checkout session did not return a URL');
    }
    return { url };
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

  /**
   * Ensures Stripe Product + recurring Price exist and match the GymOS plan (amount, interval).
   */
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
