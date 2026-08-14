import { NotFoundException } from '@nestjs/common';
import { BillingService } from './billing.service';

const stripe = {
  createProductForPlan: jest.fn(),
  createRecurringPrice: jest.fn(),
  retrievePrice: jest.fn(),
  createCheckoutSession: jest.fn(),
  createBillingPortalSession: jest.fn(),
  createOrRetrieveCustomer: jest.fn(),
  updateSubscription: jest.fn(),
  cancelSubscription: jest.fn(),
  scheduleSubscriptionPriceChangeAtPeriodEnd: jest.fn(),
  resolveHostedInvoiceUrl: jest.fn(),
  createPaymentIntent: jest.fn(),
  createEphemeralKey: jest.fn(),
  listSubscriptionsForCustomer: jest.fn(),
  createOneTimePrice: jest.fn(),
  retrieveSubscription: jest.fn(),
};

const prisma = {
  membershipPlan: {
    findFirst: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  studioMembership: { findUnique: jest.fn() },
  user: { findFirst: jest.fn(), update: jest.fn() },
};

const config = { getOrThrow: jest.fn() };

function buildService() {
  return new BillingService(
    prisma as never,
    stripe as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

beforeEach(() => jest.clearAllMocks());

// ── ensureMembershipPlanStripePrice ───────────────────────────────────────────

describe('BillingService.ensureMembershipPlanStripePrice', () => {
  it('returns existing stripePriceId without calling retrievePrice or createRecurringPrice', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-basic',
      name: 'Basic Access',
      priceCents: 100000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      stripeProductId: 'prod_basic',
      stripePriceId: 'price_1TiPaiGuUoCXNOREdIeDGSgc',
      deletedAt: null,
      active: true,
    });

    const service = buildService();
    const result = await service.ensureMembershipPlanStripePrice('plan-basic');

    expect(result).toEqual({
      priceId: 'price_1TiPaiGuUoCXNOREdIeDGSgc',
      productId: 'prod_basic',
    });

    // Stripe is authoritative — must NOT retrieve or replace the existing price
    expect(stripe.retrievePrice).not.toHaveBeenCalled();
    expect(stripe.createRecurringPrice).not.toHaveBeenCalled();
    expect(prisma.membershipPlan.update).not.toHaveBeenCalled();
  });

  it('returns existing stripePriceId even when local priceCents differs from Stripe amount (ARES Basic drift scenario)', async () => {
    // ARES Basic Access has local priceCents=100000 (MXN 1,000) but Stripe charges MXN 1,300.
    // The old code would detect "out of sync" and create a new Stripe Price at MXN 1,000 —
    // silently cutting revenue by MXN 300 per new subscriber.
    // The fix: trust the existing stripePriceId unconditionally.
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-basic',
      name: 'Basic Access',
      priceCents: 100000,    // stale local value — MXN 1,000
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      stripeProductId: 'prod_basic',
      stripePriceId: 'price_1TiPaiGuUoCXNOREdIeDGSgc',  // Stripe charges MXN 1,300
      deletedAt: null,
      active: true,
    });

    const service = buildService();
    const result = await service.ensureMembershipPlanStripePrice('plan-basic');

    expect(result.priceId).toBe('price_1TiPaiGuUoCXNOREdIeDGSgc');
    expect(stripe.createRecurringPrice).not.toHaveBeenCalled();
  });

  it('creates a new Stripe Price when stripePriceId is null', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-new',
      name: 'New Plan',
      priceCents: 80000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      stripeProductId: 'prod_new',
      stripePriceId: null,
      deletedAt: null,
      active: true,
    });
    stripe.createRecurringPrice.mockResolvedValue({ id: 'price_new' });
    prisma.membershipPlan.update.mockResolvedValue({});

    const service = buildService();
    const result = await service.ensureMembershipPlanStripePrice('plan-new');

    expect(stripe.createRecurringPrice).toHaveBeenCalledWith(
      expect.objectContaining({ unitAmount: 80000, currency: 'mxn', interval: 'month' }),
    );
    expect(result.priceId).toBe('price_new');
    expect(prisma.membershipPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripePriceId: 'price_new' }) }),
    );
  });

  it('creates both product and price when neither exists', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-brand-new',
      name: 'Brand New Plan',
      priceCents: 60000,
      currency: 'usd',
      billingInterval: 'YEARLY',
      stripeProductId: null,
      stripePriceId: null,
      deletedAt: null,
      active: true,
    });
    stripe.createProductForPlan.mockResolvedValue({ id: 'prod_brand_new' });
    stripe.createRecurringPrice.mockResolvedValue({ id: 'price_brand_new' });
    prisma.membershipPlan.update.mockResolvedValue({});

    const service = buildService();
    const result = await service.ensureMembershipPlanStripePrice('plan-brand-new');

    expect(stripe.createProductForPlan).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Brand New Plan' }),
    );
    expect(stripe.createRecurringPrice).toHaveBeenCalledWith(
      expect.objectContaining({ unitAmount: 60000, currency: 'usd', interval: 'year' }),
    );
    expect(result).toEqual({ priceId: 'price_brand_new', productId: 'prod_brand_new' });
  });

  it('throws NotFoundException when plan does not exist', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(null);

    const service = buildService();
    await expect(service.ensureMembershipPlanStripePrice('plan-missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(stripe.createRecurringPrice).not.toHaveBeenCalled();
  });
});

// ── checkPlanPricingIntegrity ─────────────────────────────────────────────────

describe('BillingService.checkPlanPricingIntegrity', () => {
  const basePlan = {
    id: 'plan-basic',
    name: 'Basic Access',
    priceCents: 130000,
    currency: 'mxn',
    billingInterval: 'MONTHLY',
    stripePriceId: 'price_basic',
  };

  it('returns healthy when Stripe amounts match local data exactly', async () => {
    prisma.membershipPlan.findMany.mockResolvedValue([basePlan]);
    stripe.retrievePrice.mockResolvedValue({
      unit_amount: 130000,
      currency: 'mxn',
      active: true,
      recurring: { interval: 'month' },
    });

    const service = buildService();
    const result = await service.checkPlanPricingIntegrity('studio-1');

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('healthy');
    expect(result[0].stripeUnitAmount).toBe(130000);
  });

  it('returns price_mismatch when Stripe unit_amount differs from local priceCents', async () => {
    // This is the ARES Basic Access scenario: local=100000, Stripe=130000
    prisma.membershipPlan.findMany.mockResolvedValue([
      { ...basePlan, priceCents: 100000 },
    ]);
    stripe.retrievePrice.mockResolvedValue({
      unit_amount: 130000,
      currency: 'mxn',
      active: true,
      recurring: { interval: 'month' },
    });

    const service = buildService();
    const result = await service.checkPlanPricingIntegrity('studio-1');

    expect(result[0].status).toBe('price_mismatch');
    expect(result[0].localPriceCents).toBe(100000);
    expect(result[0].stripeUnitAmount).toBe(130000);
  });

  it('returns currency_mismatch when currencies differ', async () => {
    prisma.membershipPlan.findMany.mockResolvedValue([basePlan]);
    stripe.retrievePrice.mockResolvedValue({
      unit_amount: 130000,
      currency: 'usd',  // mismatch: local is 'mxn'
      active: true,
      recurring: { interval: 'month' },
    });

    const service = buildService();
    const result = await service.checkPlanPricingIntegrity('studio-1');

    expect(result[0].status).toBe('currency_mismatch');
  });

  it('returns interval_mismatch when billing intervals differ', async () => {
    prisma.membershipPlan.findMany.mockResolvedValue([basePlan]);
    stripe.retrievePrice.mockResolvedValue({
      unit_amount: 130000,
      currency: 'mxn',
      active: true,
      recurring: { interval: 'year' },  // mismatch: local is MONTHLY → month
    });

    const service = buildService();
    const result = await service.checkPlanPricingIntegrity('studio-1');

    expect(result[0].status).toBe('interval_mismatch');
  });

  it('returns inactive_stripe_price when Stripe price is archived', async () => {
    prisma.membershipPlan.findMany.mockResolvedValue([basePlan]);
    stripe.retrievePrice.mockResolvedValue({
      unit_amount: 130000,
      currency: 'mxn',
      active: false,
      recurring: { interval: 'month' },
    });

    const service = buildService();
    const result = await service.checkPlanPricingIntegrity('studio-1');

    expect(result[0].status).toBe('inactive_stripe_price');
  });

  it('returns no_stripe_price when plan has no stripePriceId', async () => {
    prisma.membershipPlan.findMany.mockResolvedValue([
      { ...basePlan, stripePriceId: null },
    ]);

    const service = buildService();
    const result = await service.checkPlanPricingIntegrity('studio-1');

    expect(result[0].status).toBe('no_stripe_price');
    expect(stripe.retrievePrice).not.toHaveBeenCalled();
  });

  it('returns fetch_error when Stripe API call throws', async () => {
    prisma.membershipPlan.findMany.mockResolvedValue([basePlan]);
    stripe.retrievePrice.mockRejectedValue(new Error('Stripe network error'));

    const service = buildService();
    const result = await service.checkPlanPricingIntegrity('studio-1');

    expect(result[0].status).toBe('fetch_error');
  });

  it('processes multiple plans and returns correct status for each', async () => {
    prisma.membershipPlan.findMany.mockResolvedValue([
      { ...basePlan, id: 'plan-basic', priceCents: 100000, stripePriceId: 'price_basic' },
      { ...basePlan, id: 'plan-full', name: 'Full Access', priceCents: 150000, stripePriceId: 'price_full' },
    ]);
    stripe.retrievePrice.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_basic') {
        return { unit_amount: 130000, currency: 'mxn', active: true, recurring: { interval: 'month' } };
      }
      return { unit_amount: 150000, currency: 'mxn', active: true, recurring: { interval: 'month' } };
    });

    const service = buildService();
    const result = await service.checkPlanPricingIntegrity('studio-1');

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.planId === 'plan-basic')?.status).toBe('price_mismatch');
    expect(result.find((r) => r.planId === 'plan-full')?.status).toBe('healthy');
  });
});
