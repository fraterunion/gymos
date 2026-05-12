import Stripe from 'stripe';
import type { StripeService } from '../../src/stripe/stripe.service';

export function createE2eStripeServiceMock(config: {
  webhookSecret: string;
  secretKey: string;
}): StripeService {
  const sdk = new Stripe(config.secretKey, {
    typescript: true,
    apiVersion: '2025-08-27.basil',
  });

  const mockSubscription = (
    overrides: Partial<Stripe.Subscription> & Pick<Stripe.Subscription, 'id' | 'customer'>,
  ): Stripe.Subscription =>
    ({
      object: 'subscription',
      status: 'active',
      current_period_start: Math.floor(Date.now() / 1000),
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      cancel_at_period_end: false,
      metadata: {},
      ...overrides,
    }) as Stripe.Subscription;

  return {
    constructWebhookEvent: (payload: Buffer, signature: string) =>
      sdk.webhooks.constructEvent(payload, signature, config.webhookSecret),

    createOrRetrieveCustomer: jest.fn().mockImplementation(async (params) => {
      if (params.existingStripeCustomerId) {
        return {
          id: params.existingStripeCustomerId,
          object: 'customer',
          deleted: undefined,
        } as Stripe.Customer;
      }
      return { id: 'cus_e2e_test_customer', object: 'customer' } as Stripe.Customer;
    }),

    createCheckoutSession: jest.fn().mockResolvedValue({
      id: 'cs_e2e_test',
      object: 'checkout.session',
      url: 'https://checkout.stripe.com/e2e-mock-session',
    } as Stripe.Checkout.Session),

    createBillingPortalSession: jest.fn().mockResolvedValue({
      id: 'bps_e2e_test',
      object: 'billing_portal.session',
      url: 'https://billing.stripe.com/e2e-mock-portal',
    } as Stripe.BillingPortal.Session),

    retrieveSubscription: jest
      .fn()
      .mockImplementation(async (id: string) =>
        mockSubscription({
          id,
          customer: 'cus_e2e_test_customer',
          metadata: {},
        }),
      ),

    retrievePrice: jest.fn().mockResolvedValue({
      id: 'price_e2e',
      object: 'price',
      unit_amount: 1000,
      currency: 'usd',
      recurring: { interval: 'month' },
    } as Stripe.Price),

    createProductForPlan: jest.fn().mockResolvedValue({
      id: 'prod_e2e_test',
      object: 'product',
    } as Stripe.Product),

    createRecurringPrice: jest.fn().mockResolvedValue({
      id: 'price_e2e_test',
      object: 'price',
    } as Stripe.Price),
  } as unknown as StripeService;
}