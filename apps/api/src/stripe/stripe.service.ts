import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/** Read-only view of a failed invoice and its newest payment attempt (no PII, no card data). */
export type InvoicePaymentFailureSnapshot = {
  invoiceStatus: string | null;
  billingReason: string | null;
  attemptCount: number | null;
  nextPaymentAttemptAt: Date | null;
  amountRemaining: number | null;
  paymentIntentStatus: string | null;
  errorType: string | null;
  errorCode: string | null;
  declineCode: string | null;
  outcomeType: string | null;
  outcomeReason: string | null;
  lastAttemptAt: Date | null;
  hasPaymentMethod: boolean | null;
};

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

  /**
   * READ-ONLY. `timeoutMs` bounds request-path callers (webhook guard, Admin actions) so a Stripe
   * brownout cannot hold a request for the SDK's 80 s default.
   */
  async retrieveSubscription(subscriptionId: string, opts: { timeoutMs?: number } = {}): Promise<Stripe.Subscription> {
    const options = opts.timeoutMs ? { timeout: opts.timeoutMs, maxNetworkRetries: 1 } : undefined;
    return this.getClient().subscriptions.retrieve(subscriptionId, undefined, options) as Promise<Stripe.Subscription>;
  }

  /**
   * READ-ONLY. The invoice a PaymentIntent paid, via the InvoicePayment resource (basil removed
   * `charge.invoice` / `payment_intent.invoice`). Null when none or ambiguous.
   */
  async findInvoiceIdForPaymentIntent(paymentIntentId: string): Promise<string | null> {
    const page = await this.getClient().invoicePayments.list(
      { payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 2 },
      { timeout: 4_000, maxNetworkRetries: 1 },
    );
    if (page.data.length !== 1) return null;
    const invoice = page.data[0]!.invoice;
    return typeof invoice === 'string' ? invoice : invoice?.id ?? null;
  }

  async retrievePrice(priceId: string): Promise<Stripe.Price> {
    return this.getClient().prices.retrieve(priceId);
  }

  /**
   * READ-ONLY. The single PaymentIntent that paid `invoiceId`, or null when there is none or more
   * than one. Basil-and-later invoices no longer embed `payment_intent`; the InvoicePayment list
   * is the supported way to resolve it. Short timeout: callers treat this as best-effort.
   */
  async findPaidInvoicePaymentIntentId(invoiceId: string): Promise<string | null> {
    const payments = await this.getClient().invoicePayments.list(
      { invoice: invoiceId, status: 'paid', limit: 5 },
      { timeout: 3_000, maxNetworkRetries: 0 },
    );
    const ids = new Set<string>();
    for (const invoicePayment of payments.data) {
      if (invoicePayment.payment.type !== 'payment_intent') continue;
      const ref = invoicePayment.payment.payment_intent;
      const id = typeof ref === 'string' ? ref : ref?.id;
      if (id) ids.add(id);
    }
    return ids.size === 1 ? [...ids][0] : null;
  }

  /**
   * READ-ONLY. Collection state of an invoice and the error of its most recent payment attempt,
   * for staff-facing explanations ("why did this renewal fail?"). Dahlia webhook payloads carry
   * no decline data, so this is the only source of it. Three GETs, short timeout, no retries:
   * callers treat any failure as "reason unavailable".
   */
  async getInvoicePaymentFailureSnapshot(invoiceId: string): Promise<InvoicePaymentFailureSnapshot> {
    const client = this.getClient();
    const options = { timeout: 2_500, maxNetworkRetries: 0 };
    const [invoice, payments] = await Promise.all([
      client.invoices.retrieve(invoiceId, {}, options),
      client.invoicePayments.list({ invoice: invoiceId, limit: 10 }, options),
    ]);
    const newestAttempt = [...payments.data]
      .filter((p) => p.payment.type === 'payment_intent')
      .sort((a, b) => b.created - a.created)[0];
    const ref = newestAttempt?.payment.payment_intent;
    const paymentIntentId = typeof ref === 'string' ? ref : ref?.id;
    const intent = paymentIntentId
      ? await client.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] }, options)
      : null;
    const charge = intent?.latest_charge && typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
    const error = intent?.last_payment_error ?? null;
    return {
      invoiceStatus: invoice.status ?? null,
      billingReason: invoice.billing_reason ?? null,
      attemptCount: invoice.attempt_count ?? null,
      nextPaymentAttemptAt: invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000) : null,
      amountRemaining: invoice.amount_remaining ?? null,
      paymentIntentStatus: intent?.status ?? null,
      errorType: error?.type ?? null,
      errorCode: error?.code ?? null,
      declineCode: error?.decline_code ?? null,
      outcomeType: charge?.outcome?.type ?? null,
      outcomeReason: charge?.outcome?.reason ?? null,
      lastAttemptAt: charge ? new Date(charge.created * 1000) : null,
      hasPaymentMethod: intent ? Boolean(intent.payment_method ?? error?.payment_method) : invoice.default_payment_method ? true : null,
    };
  }

  async createProductForPlan(
    params: {
      name: string;
      metadata: Record<string, string>;
    },
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Product> {
    return this.getClient().products.create(
      {
        name: params.name,
        metadata: params.metadata,
      },
      options,
    );
  }

  async createRecurringPrice(
    params: {
      productId: string;
      unitAmount: number;
      currency: string;
      interval: Stripe.PriceCreateParams.Recurring.Interval;
      intervalCount?: number;
      metadata?: Record<string, string>;
    },
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Price> {
    return this.getClient().prices.create(
      {
        product: params.productId,
        unit_amount: params.unitAmount,
        currency: params.currency.toLowerCase(),
        recurring: {
          interval: params.interval,
          ...(params.intervalCount ? { interval_count: params.intervalCount } : {}),
        },
        ...(params.metadata ? { metadata: params.metadata } : {}),
      },
      options,
    );
  }

  /** Archive a Price for new sales. Existing subscriptions on it remain valid in Stripe. */
  async deactivatePrice(priceId: string): Promise<Stripe.Price> {
    return this.getClient().prices.update(priceId, { active: false });
  }

  async createOneTimePrice(
    params: {
      productId: string;
      unitAmount: number;
      currency: string;
      metadata?: Record<string, string>;
    },
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.Price> {
    return this.getClient().prices.create(
      {
        product: params.productId,
        unit_amount: params.unitAmount,
        currency: params.currency.toLowerCase(),
        ...(params.metadata ? { metadata: params.metadata } : {}),
      },
      options,
    );
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
    idempotencyKey?: string;
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

    return stripe.subscriptions.update(
      params.stripeSubscriptionId,
      {
        cancel_at_period_end: false,
        metadata: params.metadata,
      },
      params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined,
    );
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

  /**
   * Creates a PaymentIntent. Callers that represent a retryable purchase attempt MUST pass
   * `options.idempotencyKey` so a client retry or a duplicate tap can never mint a second
   * chargeable intent for the same attempt (Stripe replays the original response instead).
   */
  async createPaymentIntent(
    params: Stripe.PaymentIntentCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.PaymentIntent> {
    return this.getClient().paymentIntents.create(params, options);
  }

  /**
   * Live PaymentIntent status from Stripe. This is the authority for "was this attempt paid?":
   * local rows and mobile clients only ever cache it.
   */
  async retrievePaymentIntent(paymentIntentId: string): Promise<Stripe.PaymentIntent> {
    // latest_charge is expanded so callers can see refunds (a refund does not change the
    // intent's `succeeded` status).
    return this.getClient().paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
  }

  /**
   * Cancels a PaymentIntent that has not succeeded. Stripe rejects cancellation of a
   * `succeeded` or `processing` intent (payment_intent_invalid_cancellation_state), so callers
   * must only invoke this after retrieving a status in requires_payment_method /
   * requires_confirmation / requires_action.
   */
  async cancelPaymentIntent(
    paymentIntentId: string,
    cancellationReason: Stripe.PaymentIntentCancelParams.CancellationReason = 'abandoned',
  ): Promise<Stripe.PaymentIntent> {
    return this.getClient().paymentIntents.cancel(paymentIntentId, {
      cancellation_reason: cancellationReason,
    });
  }

  async createEphemeralKey(customerId: string, stripeApiVersion: string): Promise<Stripe.EphemeralKey> {
    return this.getClient().ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: stripeApiVersion },
    );
  }

  /**
   * List all Stripe subscriptions for a customer across all statuses.
   * Used by the reconciliation layer to detect orphaned or duplicate subscriptions.
   * Callers are responsible for filtering by studioId via subscription metadata.
   */
  /**
   * All of a customer's subscriptions. Stripe omits canceled ones by default; reconciliation
   * passes `includeCanceled` so "ended in Stripe" and "unknown to Stripe" can be told apart.
   */
  async listSubscriptionsForCustomer(
    customerId: string,
    opts: { includeCanceled?: boolean } = {},
  ): Promise<Stripe.Subscription[]> {
    const stripe = this.getClient();
    const results: Stripe.Subscription[] = [];
    for await (const sub of stripe.subscriptions.list({
      customer: customerId,
      limit: 100,
      ...(opts.includeCanceled ? { status: 'all' } : {}),
    })) {
      results.push(sub as Stripe.Subscription);
    }
    return results;
  }

  // ── Read-only reconciliation lookups (GET only; bounded by `limit`) ─────────

  async listOpenInvoicesForCustomer(customerId: string, limit = 25): Promise<Stripe.Invoice[]> {
    const page = await this.getClient().invoices.list({ customer: customerId, status: 'open', limit });
    return page.data;
  }

  async listRefundsSince(createdGteUnix: number, limit = 100): Promise<{ data: Stripe.Refund[]; hasMore: boolean }> {
    const page = await this.getClient().refunds.list({ created: { gte: createdGteUnix }, limit });
    return { data: page.data, hasMore: page.has_more };
  }

  async listDisputesSince(createdGteUnix: number, limit = 100): Promise<{ data: Stripe.Dispute[]; hasMore: boolean }> {
    const page = await this.getClient().disputes.list({ created: { gte: createdGteUnix }, limit });
    return { data: page.data, hasMore: page.has_more };
  }

  async retrieveCharge(chargeId: string): Promise<Stripe.Charge> {
    return this.getClient().charges.retrieve(chargeId);
  }

  async retrieveInvoice(invoiceId: string): Promise<Stripe.Invoice> {
    return this.getClient().invoices.retrieve(invoiceId);
  }
}
