import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private client: Stripe | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): Stripe {
    if (!this.client) {
      const secret = this.config.getOrThrow<string>('STRIPE_SECRET_KEY');
      this.client = new Stripe(secret, {
        typescript: true,
        apiVersion: '2025-08-27.basil',
      });
    }
    return this.client;
  }

  constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
    const secret = this.config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
    return this.getClient().webhooks.constructEvent(payload, signature, secret);
  }

  async createOrRetrieveCustomer(params: {
    email: string;
    name: string;
    existingStripeCustomerId: string | null;
    metadata: Record<string, string>;
  }): Promise<Stripe.Customer> {
    const stripe = this.getClient();
    if (params.existingStripeCustomerId) {
      try {
        const existing = await stripe.customers.retrieve(params.existingStripeCustomerId);
        if (!existing.deleted) {
          return existing;
        }
      } catch {
        // Customer missing in Stripe (e.g. test DB reset); create a new one below.
      }
    }
    return stripe.customers.create({
      email: params.email,
      name: params.name,
      metadata: params.metadata,
    });
  }

  async createCheckoutSession(params: Stripe.Checkout.SessionCreateParams): Promise<Stripe.Checkout.Session> {
    return this.getClient().checkout.sessions.create(params);
  }

  async createBillingPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<Stripe.BillingPortal.Session> {
    return this.getClient().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
  }

  async retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.getClient().subscriptions.retrieve(subscriptionId) as Promise<Stripe.Subscription>;
  }

  async retrievePrice(priceId: string): Promise<Stripe.Price> {
    return this.getClient().prices.retrieve(priceId);
  }

  async createProductForPlan(params: {
    name: string;
    metadata: Record<string, string>;
  }): Promise<Stripe.Product> {
    return this.getClient().products.create({
      name: params.name,
      metadata: params.metadata,
    });
  }

  async createRecurringPrice(params: {
    productId: string;
    unitAmount: number;
    currency: string;
    interval: Stripe.PriceCreateParams.Recurring.Interval;
  }): Promise<Stripe.Price> {
    return this.getClient().prices.create({
      product: params.productId,
      unit_amount: params.unitAmount,
      currency: params.currency.toLowerCase(),
      recurring: { interval: params.interval },
    });
  }

  async updateSubscription(
    subscriptionId: string,
    params: Stripe.SubscriptionUpdateParams,
  ): Promise<Stripe.Subscription> {
    return this.getClient().subscriptions.update(subscriptionId, params);
  }

  async createPaymentIntent(params: Stripe.PaymentIntentCreateParams): Promise<Stripe.PaymentIntent> {
    return this.getClient().paymentIntents.create(params);
  }

  async createEphemeralKey(customerId: string, stripeApiVersion: string): Promise<Stripe.EphemeralKey> {
    return this.getClient().ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: stripeApiVersion },
    );
  }
}
