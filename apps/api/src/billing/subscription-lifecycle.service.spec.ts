import { BadRequestException, ConflictException } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { STRIPE_IMMEDIATE_UPGRADE_PARAMS } from './subscription-plan-resolution.utils';
import { isUpgrade } from './subscription-lifecycle.utils';

describe('subscription-lifecycle.utils', () => {
  it('detects upgrade vs downgrade by price', () => {
    expect(isUpgrade(1300, 1500)).toBe(true);
    expect(isUpgrade(1500, 1300)).toBe(false);
  });
});

describe('SubscriptionLifecycleService', () => {
  const stripe = {
    retrieveSubscription: jest.fn(),
    retrievePrice: jest.fn(),
    updateSubscription: jest.fn(),
    scheduleSubscriptionPriceChangeAtPeriodEnd: jest.fn(),
    resolveHostedInvoiceUrl: jest.fn(),
    cancelSubscription: jest.fn(),
  };

  const prisma = {
    membershipPlan: { findFirst: jest.fn() },
    subscription: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  };

  const service = new SubscriptionLifecycleService(prisma as never, stripe as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
    prisma.subscription.update.mockResolvedValue({ id: 'sub-local-1', membershipPlan: {} });
    prisma.subscription.findMany.mockResolvedValue([]);
    prisma.membershipPlan.findFirst.mockImplementation(async (args: { where: { stripePriceId?: string } }) => {
      if (args.where.stripePriceId === 'price_basic') return { id: 'plan-basic' };
      if (args.where.stripePriceId === 'price_full') return { id: 'plan-full' };
      return null;
    });
    // Default retrievePrice: return unit_amounts aligned with test priceCents values.
    stripe.retrievePrice.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_basic') return { unit_amount: 1300 };
      if (priceId === 'price_full') return { unit_amount: 1500 };
      return { unit_amount: 1000 };
    });
  });

  it('routes first purchase to checkout when no Stripe subscription exists', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-full',
      name: 'Full Access',
      priceCents: 1500,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
    });

    const result = await service.initiateMembershipPurchase({
      targetUserId: 'user-1',
      studioId: 'studio-1',
      planId: 'plan-full',
      newStripePriceId: 'price_full',
      createCheckout: jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.stripe.com/test' }),
    });

    expect(result).toEqual({ action: 'checkout', url: 'https://checkout.stripe.com/test' });
  });

  it('immediate upgrade uses always_invoice + pending_if_incomplete', async () => {
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'sub-local-1',
      studioId: 'studio-1',
      userId: 'user-1',
      stripeSubscriptionId: 'sub_stripe_1',
      membershipPlanId: 'plan-basic',
      pendingMembershipPlanId: null,
      membershipPlan: {
        id: 'plan-basic',
        name: 'Basic Access',
        priceCents: 1300,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
      },
    });
    prisma.membershipPlan.findFirst.mockImplementation(async (args: { where: { id?: string; stripePriceId?: string } }) => {
      if (args.where.id === 'plan-full') {
        return { id: 'plan-full', name: 'Full Access', priceCents: 1500, currency: 'mxn', billingInterval: 'MONTHLY' };
      }
      if (args.where.stripePriceId === 'price_full') return { id: 'plan-full' };
      if (args.where.stripePriceId === 'price_basic') return { id: 'plan-basic' };
      return null;
    });

    stripe.retrieveSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: true,
      items: { data: [{ id: 'si_1', price: { id: 'price_basic' } }] },
    });
    stripe.updateSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', price: { id: 'price_full' } }] },
    });

    await service.initiateMembershipPurchase({
      targetUserId: 'user-1',
      studioId: 'studio-1',
      planId: 'plan-full',
      newStripePriceId: 'price_full',
      createCheckout: jest.fn(),
    });

    expect(stripe.updateSubscription).toHaveBeenCalledWith(
      'sub_stripe_1',
      expect.objectContaining({
        ...STRIPE_IMMEDIATE_UPGRADE_PARAMS,
        cancel_at_period_end: false,
      }),
      undefined,
    );
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          membershipPlanId: 'plan-full',
          pendingMembershipPlanId: null,
          cancelAtPeriodEnd: false,
        }),
      }),
    );
  });

  it('normal immediate upgrade sends cancel_at_period_end=false to Stripe and activates new plan locally', async () => {
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'sub-local-1',
      studioId: 'studio-1',
      userId: 'user-1',
      stripeSubscriptionId: 'sub_stripe_1',
      membershipPlanId: 'plan-basic',
      pendingMembershipPlanId: null,
      membershipPlan: { id: 'plan-basic', name: 'Basic Access', priceCents: 1300, currency: 'mxn', billingInterval: 'MONTHLY' },
    });
    prisma.membershipPlan.findFirst.mockImplementation(async (args: { where: { id?: string; stripePriceId?: string } }) => {
      if (args.where.id === 'plan-full') return { id: 'plan-full', name: 'Full Access', priceCents: 1500, currency: 'mxn', billingInterval: 'MONTHLY' };
      if (args.where.stripePriceId === 'price_full') return { id: 'plan-full' };
      if (args.where.stripePriceId === 'price_basic') return { id: 'plan-basic' };
      return null;
    });

    stripe.retrieveSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', price: { id: 'price_basic' } }] },
    });
    stripe.updateSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', price: { id: 'price_full' } }] },
    });

    await service.initiateMembershipPurchase({
      targetUserId: 'user-1',
      studioId: 'studio-1',
      planId: 'plan-full',
      newStripePriceId: 'price_full',
      createCheckout: jest.fn(),
    });

    expect(stripe.updateSubscription).toHaveBeenCalledWith(
      'sub_stripe_1',
      expect.objectContaining({
        ...STRIPE_IMMEDIATE_UPGRADE_PARAMS,
        cancel_at_period_end: false,
      }),
      undefined,
    );
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ membershipPlanId: 'plan-full', cancelAtPeriodEnd: false }),
      }),
    );
  });

  it('does not apply new effective plan when upgrade payment is incomplete', async () => {
    stripe.retrieveSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      items: { data: [{ id: 'si_1', price: { id: 'price_basic' } }] },
    });
    stripe.updateSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'incomplete',
      items: { data: [{ id: 'si_1', price: { id: 'price_basic' } }] },
    });

    await service.changeStripeSubscriptionPlan({
      studioId: 'studio-1',
      userId: 'user-1',
      localSubscription: {
        id: 'sub-local-1',
        stripeSubscriptionId: 'sub_stripe_1',
        membershipPlanId: 'plan-basic',
        pendingMembershipPlanId: null,
        membershipPlan: {
          id: 'plan-basic',
          name: 'Basic Access',
          priceCents: 1300,
          currency: 'mxn',
          billingInterval: 'MONTHLY',
        },
      } as never,
      targetPlan: {
        id: 'plan-full',
        name: 'Full Access',
        priceCents: 1500,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
      } as never,
      newStripePriceId: 'price_full',
    });

    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          membershipPlanId: 'plan-basic',
          pendingMembershipPlanId: null,
        }),
      }),
    );
  });

  it('scheduled downgrade keeps effective plan and stores pending plan only', async () => {
    stripe.retrieveSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      items: { data: [{ id: 'si_1', price: { id: 'price_full' }, current_period_end: 1_702_592_000 }] },
    });
    stripe.scheduleSubscriptionPriceChangeAtPeriodEnd.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: false,
      metadata: { pendingPlanId: 'plan-basic' },
      items: { data: [{ id: 'si_1', price: { id: 'price_full' }, current_period_end: 1_702_592_000 }] },
    });

    const result = await service.changeStripeSubscriptionPlan({
      studioId: 'studio-1',
      userId: 'user-1',
      localSubscription: {
        id: 'sub-local-1',
        stripeSubscriptionId: 'sub_stripe_1',
        membershipPlanId: 'plan-full',
        pendingMembershipPlanId: null,
        membershipPlan: {
          id: 'plan-full',
          name: 'Full Access',
          priceCents: 1500,
          currency: 'mxn',
          billingInterval: 'MONTHLY',
        },
      } as never,
      targetPlan: {
        id: 'plan-basic',
        name: 'Basic Access',
        priceCents: 1300,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
      } as never,
      newStripePriceId: 'price_basic',
    });

    expect(result.effective).toBe('next_period');
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          membershipPlanId: 'plan-full',
          pendingMembershipPlanId: 'plan-basic',
        }),
      }),
    );
  });

  it('scheduled downgrade from cancelAtPeriodEnd=true explicitly resolves cancellation and stores pending plan', async () => {
    stripe.retrieveSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: true,
      items: { data: [{ id: 'si_1', price: { id: 'price_full' }, current_period_end: 1_702_592_000 }] },
    });
    stripe.scheduleSubscriptionPriceChangeAtPeriodEnd.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: false,
      metadata: { pendingPlanId: 'plan-basic' },
      items: { data: [{ id: 'si_1', price: { id: 'price_full' }, current_period_end: 1_702_592_000 }] },
    });

    const result = await service.changeStripeSubscriptionPlan({
      studioId: 'studio-1',
      userId: 'user-1',
      localSubscription: {
        id: 'sub-local-1',
        stripeSubscriptionId: 'sub_stripe_1',
        membershipPlanId: 'plan-full',
        pendingMembershipPlanId: null,
        membershipPlan: { id: 'plan-full', name: 'Full Access', priceCents: 1500, currency: 'mxn', billingInterval: 'MONTHLY' },
      } as never,
      targetPlan: {
        id: 'plan-basic',
        name: 'Basic Access',
        priceCents: 1300,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
      } as never,
      newStripePriceId: 'price_basic',
    });

    expect(stripe.scheduleSubscriptionPriceChangeAtPeriodEnd).toHaveBeenCalled();
    expect(result.effective).toBe('next_period');
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          membershipPlanId: 'plan-full',
          pendingMembershipPlanId: 'plan-basic',
          cancelAtPeriodEnd: false,
        }),
      }),
    );
  });

  it('reconcile activates pending plan only when Stripe price matches pending plan', async () => {
    const result = await service.reconcileSubscriptionPlansFromStripe(prisma as never, {
      stripeSubscriptionId: 'sub_stripe_1',
      stripePriceId: 'price_basic',
      metadata: { pendingPlanId: 'plan-basic' },
      fallbackPlanId: 'plan-full',
    });

    expect(result).toEqual({
      membershipPlanId: 'plan-basic',
      pendingMembershipPlanId: null,
    });
  });

  it('reconcile keeps Full effective with pending Basic before period end', async () => {
    const result = await service.reconcileSubscriptionPlansFromStripe(prisma as never, {
      stripeSubscriptionId: 'sub_stripe_1',
      stripePriceId: 'price_full',
      metadata: { pendingPlanId: 'plan-basic' },
      fallbackPlanId: 'plan-full',
    });

    expect(result).toEqual({
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: 'plan-basic',
    });
  });

  it('auditDuplicateRenewableSubscriptions logs and does not cancel Stripe', async () => {
    const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    prisma.subscription.findMany.mockResolvedValue([
      {
        id: 'sub-old',
        stripeSubscriptionId: 'sub_old',
        membershipPlanId: 'plan-basic',
        membershipPlan: { id: 'plan-basic', name: 'Basic Access' },
        status: SubscriptionStatus.ACTIVE,
        source: 'STRIPE',
        cancelAtPeriodEnd: false,
        createdAt: new Date(),
      },
    ]);

    await service.auditDuplicateRenewableSubscriptions(prisma as never, {
      studioId: 'studio-1',
      userId: 'user-1',
      keepSubscriptionId: 'sub-new',
      keepStripeSubscriptionId: 'sub_new',
      source: 'webhook',
      stripeEventType: 'customer.subscription.updated',
    });

    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  // ── Reconciliation safety gate ────────────────────────────────────────────

  it('blocks plan change with ConflictException when reconciliation detects duplicate_renewable', async () => {
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'sub-local-1',
      stripeSubscriptionId: 'sub_stripe_1',
      membershipPlanId: 'plan-basic',
      pendingMembershipPlanId: null,
      membershipPlan: { id: 'plan-basic', name: 'Basic', priceCents: 1300, currency: 'mxn', billingInterval: 'MONTHLY' },
    });
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-full',
      name: 'Full Access',
      priceCents: 1500,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
    });

    const reconciliation = {
      assertHealthyForPlanChange: jest.fn().mockRejectedValue(
        new ConflictException({
          code: 'BILLING_STATE_REQUIRES_RECONCILIATION',
          reconciliationStatus: 'duplicate_renewable',
          issues: ['duplicate_renewable', 'stripe_orphan'],
        }),
      ),
    };

    const serviceWithReconciliation = new SubscriptionLifecycleService(
      prisma as never,
      stripe as never,
      reconciliation as never,
    );

    await expect(
      serviceWithReconciliation.initiateMembershipPurchase({
        targetUserId: 'user-1',
        studioId: 'studio-1',
        planId: 'plan-full',
        newStripePriceId: 'price_full',
        createCheckout: jest.fn(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(reconciliation.assertHealthyForPlanChange).toHaveBeenCalledWith('studio-1', 'user-1');
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('reconciliation gate runs before checkout path — stripe_orphan with no local sub blocks checkout creation', async () => {
    // Critical regression test: Stripe has an active subscription but local DB has no row.
    // findPrimaryStripeSubscription returns null → without the early gate, checkout
    // would be created and the member would end up with two concurrent Stripe subscriptions.
    prisma.subscription.findFirst.mockResolvedValue(null);
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-full',
      name: 'Full Access',
      priceCents: 1500,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
    });

    const reconciliation = {
      assertHealthyForPlanChange: jest.fn().mockRejectedValue(
        new ConflictException({
          code: 'BILLING_STATE_REQUIRES_RECONCILIATION',
          reconciliationStatus: 'stripe_orphan',
          issues: ['stripe_orphan'],
        }),
      ),
    };

    const createCheckout = jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.stripe.com/x' });

    const serviceWithReconciliation = new SubscriptionLifecycleService(
      prisma as never,
      stripe as never,
      reconciliation as never,
    );

    await expect(
      serviceWithReconciliation.initiateMembershipPurchase({
        targetUserId: 'user-1',
        studioId: 'studio-1',
        planId: 'plan-full',
        newStripePriceId: 'price_full',
        createCheckout,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // The gate ran and aborted before createCheckout was ever called
    expect(reconciliation.assertHealthyForPlanChange).toHaveBeenCalledWith('studio-1', 'user-1');
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it('reconciliation gate passes for healthy new member — proceeds to checkout', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-full',
      name: 'Full Access',
      priceCents: 1500,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
    });

    const reconciliation = {
      assertHealthyForPlanChange: jest.fn().mockResolvedValue(undefined), // healthy
    };

    const createCheckout = jest.fn().mockResolvedValue({ checkoutUrl: 'https://checkout.stripe.com/x' });

    const serviceWithReconciliation = new SubscriptionLifecycleService(
      prisma as never,
      stripe as never,
      reconciliation as never,
    );

    const result = await serviceWithReconciliation.initiateMembershipPurchase({
      targetUserId: 'user-1',
      studioId: 'studio-1',
      planId: 'plan-full',
      newStripePriceId: 'price_full',
      createCheckout,
    });

    expect(result).toMatchObject({ action: 'checkout' });
    expect(reconciliation.assertHealthyForPlanChange).toHaveBeenCalledWith('studio-1', 'user-1');
    expect(createCheckout).toHaveBeenCalled();
  });

  it('throws when selecting the same active plan', async () => {
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'sub-local-1',
      stripeSubscriptionId: 'sub_stripe_1',
      membershipPlanId: 'plan-full',
      pendingMembershipPlanId: null,
      membershipPlan: { id: 'plan-full', name: 'Full', priceCents: 1500, currency: 'mxn', billingInterval: 'MONTHLY' },
    });
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-full',
      name: 'Full Access',
      priceCents: 1500,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
    });

    await expect(
      service.initiateMembershipPurchase({
        targetUserId: 'user-1',
        studioId: 'studio-1',
        planId: 'plan-full',
        newStripePriceId: 'price_full',
        createCheckout: jest.fn(),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // ── Stripe-authoritative isUpgrade (Phase 4 fix) ──────────────────────────

  it('uses Stripe unit_amounts (not stale local priceCents) for upgrade/downgrade determination', async () => {
    // Scenario: local priceCents says Basic=1600, Full=1500 → isUpgrade would return false
    // (downgrade), scheduling at period end. But Stripe says Basic=1300, Full=1500 → it is
    // actually an upgrade and should fire immediately. Stripe amounts must win.
    stripe.retrieveSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', price: { id: 'price_basic_stale' } }] },
    });
    stripe.updateSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', price: { id: 'price_full' } }] },
    });
    // Stripe says: Basic=1300, Full=1500 → upgrade
    stripe.retrievePrice.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_basic_stale') return { unit_amount: 1300 };
      if (priceId === 'price_full') return { unit_amount: 1500 };
      return { unit_amount: 0 };
    });
    prisma.membershipPlan.findFirst.mockImplementation(async (args: { where: { id?: string; stripePriceId?: string } }) => {
      if (args.where.stripePriceId === 'price_full') return { id: 'plan-full' };
      if (args.where.stripePriceId === 'price_basic_stale') return { id: 'plan-basic' };
      return null;
    });

    const result = await service.changeStripeSubscriptionPlan({
      studioId: 'studio-1',
      userId: 'user-1',
      localSubscription: {
        id: 'sub-local-1',
        stripeSubscriptionId: 'sub_stripe_1',
        membershipPlanId: 'plan-basic',
        pendingMembershipPlanId: null,
        membershipPlan: {
          id: 'plan-basic',
          name: 'Basic Access',
          priceCents: 1600,  // stale — would classify as downgrade if used
          currency: 'mxn',
          billingInterval: 'MONTHLY',
        },
      } as never,
      targetPlan: {
        id: 'plan-full',
        name: 'Full Access',
        priceCents: 1500,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
      } as never,
      newStripePriceId: 'price_full',
    });

    // Stripe amounts say upgrade (1300→1500) → must use updateSubscription (immediate)
    expect(result.effective).toBe('immediate');
    expect(stripe.updateSubscription).toHaveBeenCalled();
    expect(stripe.scheduleSubscriptionPriceChangeAtPeriodEnd).not.toHaveBeenCalled();
  });

  it('correctly classifies as downgrade using Stripe amounts even when local priceCents would say upgrade', async () => {
    // Local: Full=1000, Basic=1500 → isUpgrade(1000, 1500) = true (upgrade) — WRONG
    // Stripe: Full=1500, Basic=1300 → isUpgrade(1500, 1300) = false (downgrade) — CORRECT
    stripe.retrieveSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', price: { id: 'price_full' }, current_period_end: 1_702_592_000 }] },
    });
    stripe.scheduleSubscriptionPriceChangeAtPeriodEnd.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: false,
      metadata: { pendingPlanId: 'plan-basic' },
      items: { data: [{ id: 'si_1', price: { id: 'price_full' }, current_period_end: 1_702_592_000 }] },
    });
    stripe.retrievePrice.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_full') return { unit_amount: 1500 };
      if (priceId === 'price_basic') return { unit_amount: 1300 };
      return { unit_amount: 0 };
    });
    prisma.membershipPlan.findFirst.mockImplementation(async (args: { where: { id?: string; stripePriceId?: string } }) => {
      if (args.where.stripePriceId === 'price_full') return { id: 'plan-full' };
      if (args.where.stripePriceId === 'price_basic') return { id: 'plan-basic' };
      return null;
    });

    const result = await service.changeStripeSubscriptionPlan({
      studioId: 'studio-1',
      userId: 'user-1',
      localSubscription: {
        id: 'sub-local-1',
        stripeSubscriptionId: 'sub_stripe_1',
        membershipPlanId: 'plan-full',
        pendingMembershipPlanId: null,
        membershipPlan: {
          id: 'plan-full',
          name: 'Full Access',
          priceCents: 1000,  // stale — would classify as upgrade if used for isUpgrade
          currency: 'mxn',
          billingInterval: 'MONTHLY',
        },
      } as never,
      targetPlan: {
        id: 'plan-basic',
        name: 'Basic Access',
        priceCents: 1500,  // stale — higher than local Full, so old code would say "upgrade"
        currency: 'mxn',
        billingInterval: 'MONTHLY',
      } as never,
      newStripePriceId: 'price_basic',
    });

    // Stripe amounts say downgrade (1500→1300) → must schedule at period end
    expect(result.effective).toBe('next_period');
    expect(stripe.scheduleSubscriptionPriceChangeAtPeriodEnd).toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('falls back to local priceCents when Stripe retrievePrice returns null unit_amount', async () => {
    stripe.retrieveSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', price: { id: 'price_basic' } }] },
    });
    stripe.updateSubscription.mockResolvedValue({
      id: 'sub_stripe_1',
      status: 'active',
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', price: { id: 'price_full' } }] },
    });
    // Stripe returns null unit_amount → falls back to local priceCents (1300 vs 1500 → upgrade)
    stripe.retrievePrice.mockResolvedValue({ unit_amount: null });

    const result = await service.changeStripeSubscriptionPlan({
      studioId: 'studio-1',
      userId: 'user-1',
      localSubscription: {
        id: 'sub-local-1',
        stripeSubscriptionId: 'sub_stripe_1',
        membershipPlanId: 'plan-basic',
        pendingMembershipPlanId: null,
        membershipPlan: { id: 'plan-basic', name: 'Basic', priceCents: 1300, currency: 'mxn', billingInterval: 'MONTHLY' },
      } as never,
      targetPlan: { id: 'plan-full', name: 'Full', priceCents: 1500, currency: 'mxn', billingInterval: 'MONTHLY' } as never,
      newStripePriceId: 'price_full',
    });

    expect(result.effective).toBe('immediate');
    expect(stripe.updateSubscription).toHaveBeenCalled();
  });
});
