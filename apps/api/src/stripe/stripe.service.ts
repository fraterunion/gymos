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

  async createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Checkout.Session> {
    return this.getClient().checkout.sessions.create(params, options);
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

  async createOneTimePrice(params: {
    productId: string;
    unitAmount: number;
    currency: string;
  }): Promise<Stripe.Price> {
    return this.getClient().prices.create({
      product: params.productId,
      unit_amount: params.unitAmount,
      currency: params.currency.toLowerCase(),
    });
  }

  async updateSubscription(
    subscriptionId: string,
    params: Stripe.SubscriptionUpdateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Subscription> {
    return this.getClient().subscriptions.update(subscriptionId, params, options);
  }

  async cancelSubscription(
    subscriptionId: string,
    params: Stripe.SubscriptionCancelParams = {},
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Subscription> {
    return this.getClient().subscriptions.cancel(subscriptionId, params, options);
  }

  async scheduleSubscriptionPriceChangeAtPeriodEnd(params: {
    stripeSubscriptionId: string;
    subscriptionItemId: string;
    currentPriceId: string;
    newPriceId: string;
    metadata: Record<string, string>;
  }): Promise<Stripe.Subscription> {
    const stripe = this.getClient();
    const sub = await stripe.subscriptions.retrieve(params.stripeSubscriptionId, {
      expand: ['schedule'],
    });

    const periodEnd = sub.items.data[0]?.current_period_end;
    if (!periodEnd) {
      throw new Error('Stripe subscription is missing current_period_end');
    }

    let scheduleId =
      typeof sub.schedule === 'string'
        ? sub.schedule
        : sub.schedule?.id ?? null;

    if (!scheduleId) {
      const created = await stripe.subscriptionSchedules.create({
        from_subscription: params.stripeSubscriptionId,
      });
      scheduleId = created.id;
    }

    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    const phaseStart = schedule.phases[0]?.start_date ?? sub.items.data[0]?.current_period_start;
    if (!phaseStart) {
      throw new Error('Unable to resolve subscription schedule phase start');
    }

    await stripe.subscriptionSchedules.update(scheduleId, {
      end_behavior: 'release',
      phases: [
        {
          items: [{ price: params.currentPriceId, quantity: 1 }],
          start_date: phaseStart,
          end_date: periodEnd,
          metadata: params.metadata,
        },
        {
          items: [{ price: params.newPriceId, quantity: 1 }],
          start_date: periodEnd,
          metadata: params.metadata,
        },
      ],
    });

    return stripe.subscriptions.update(params.stripeSubscriptionId, {
      cancel_at_period_end: false,
      metadata: params.metadata,
    });
  }

  async resolveHostedInvoiceUrl(stripeSubscriptionId: string): Promise<string | null> {
    const stripe = this.getClient();
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
      expand: ['latest_invoice'],
    });
    const invoice = sub.latest_invoice;
    if (!invoice) return null;
    if (typeof invoice === 'string') {
      const fetched = await stripe.invoices.retrieve(invoice);
      return fetched.hosted_invoice_url ?? null;
    }
    return invoice.hosted_invoice_url ?? null;
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
