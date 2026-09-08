import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Role, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { StripeToCashTransitionService } from './stripe-to-cash-transition.service';

describe('StripeToCashTransitionService', () => {
  const stripe = {
    cancelSubscription: jest.fn(),
    updateSubscription: jest.fn(),
  };

  type PrismaMock = {
    subscription: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findFirstOrThrow: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
    };
    payment: { findFirst: jest.Mock; create: jest.Mock };
    membershipPlan: { findFirstOrThrow: jest.Mock };
    membershipEntitlementCycle: { create: jest.Mock };
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
  };

  const prisma: PrismaMock = {
    subscription: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findFirstOrThrow: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    payment: { findFirst: jest.fn(), create: jest.fn() },
    membershipPlan: { findFirstOrThrow: jest.fn() },
    membershipEntitlementCycle: { create: jest.fn() },
    $transaction: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(undefined),
  };
  prisma.$transaction.mockImplementation(
    async (fn: (tx: PrismaMock) => Promise<unknown>) => fn(prisma),
  );

  let service: StripeToCashTransitionService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (fn: (tx: PrismaMock) => Promise<unknown>) => fn(prisma),
    );
    service = new StripeToCashTransitionService(prisma as never, stripe as never);
  });

  it('OWNER/ADMIN may resolve; FRONT_DESK/STAFF may not', () => {
    expect(() => service.assertCanResolveStripe(Role.OWNER)).not.toThrow();
    expect(() => service.assertCanResolveStripe(Role.ADMIN)).not.toThrow();
    expect(() => service.assertCanResolveStripe(Role.FRONT_DESK)).toThrow(ForbiddenException);
    expect(() => service.assertCanResolveStripe(Role.STAFF)).toThrow(ForbiddenException);
    expect(service.allowedResolutionsForRole(Role.FRONT_DESK)).toEqual([]);
    expect(service.allowedResolutionsForRole(Role.ADMIN)).toEqual([
      'cancel_at_period_end',
      'cancel_immediately',
    ]);
  });

  it('buildConflictException returns Spanish structured 409', () => {
    const err = service.buildConflictException(
      {
        id: 'local-1',
        stripeSubscriptionId: 'sub_1',
        membershipPlanId: 'plan-pro',
        membershipPlan: { name: 'Pro' } as never,
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: false,
        currentPeriodStart: new Date('2026-07-30T04:50:48.000Z'),
        currentPeriodEnd: new Date('2026-08-30T04:50:48.000Z'),
      } as never,
      Role.ADMIN,
      null,
    );
    expect(err).toBeInstanceOf(ConflictException);
    const body = err.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('STRIPE_RENEWABLE_CONFLICT');
    expect(String(body.message)).toMatch(/suscripción activa/i);
  });

  it('activateScheduledCashIfDue waits while Stripe period remains', async () => {
    const future = new Date(Date.now() + 86_400_000);
    prisma.subscription.findMany
      .mockResolvedValueOnce([
        {
          id: 'cash-sched',
          status: SubscriptionStatus.SCHEDULED,
          source: SubscriptionSource.CASH,
          membershipPlanId: 'plan-pro',
          exclusiveGroupKey: null,
          membershipPlan: { id: 'plan-pro', exclusiveGroup: null },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'stripe-local',
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: future,
          stripeSubscriptionId: 'sub_1',
          membershipPlanId: 'plan-pro',
          exclusiveGroupKey: null,
          membershipPlan: { id: 'plan-pro', exclusiveGroup: null },
        },
      ]);

    const result = await service.activateScheduledCashIfDue(prisma as never, {
      studioId: 'studio-1',
      userId: 'user-1',
      now: new Date(),
    });
    expect(result).toBeNull();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  it('activateScheduledCashIfDue cancels expired Stripe and activates SCHEDULED cash', async () => {
    const past = new Date(Date.now() - 86_400_000);
    prisma.subscription.findMany
      .mockResolvedValueOnce([
        {
          id: 'cash-sched',
          status: SubscriptionStatus.SCHEDULED,
          source: SubscriptionSource.CASH,
          membershipPlanId: 'plan-pro',
          exclusiveGroupKey: null,
          membershipPlan: { id: 'plan-pro', exclusiveGroup: null },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'stripe-local',
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: past,
          stripeSubscriptionId: 'sub_1',
          membershipPlanId: 'plan-pro',
          exclusiveGroupKey: null,
          membershipPlan: { id: 'plan-pro', exclusiveGroup: null },
        },
      ]);
    prisma.subscription.update.mockResolvedValueOnce({
      id: 'stripe-local',
      status: SubscriptionStatus.CANCELED,
    });
    prisma.subscription.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.subscription.findUniqueOrThrow = jest.fn().mockResolvedValue({
      id: 'cash-sched',
      status: SubscriptionStatus.ACTIVE,
    });

    const result = await service.activateScheduledCashIfDue(prisma as never, {
      studioId: 'studio-1',
      userId: 'user-1',
      now: new Date(),
    });
    expect(result?.status).toBe(SubscriptionStatus.ACTIVE);
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cash-sched', status: SubscriptionStatus.SCHEDULED },
        data: { status: SubscriptionStatus.ACTIVE },
      }),
    );
  });

  it('idempotent period-end returns existing SUCCEEDED cash payment (no second create)', async () => {
    const periodEnd = new Date('2026-08-30T04:50:48.000Z');
    prisma.subscription.findMany
      .mockResolvedValueOnce([
        {
          id: 'stripe-local',
          stripeSubscriptionId: 'sub_1',
          status: SubscriptionStatus.ACTIVE,
          cancelAtPeriodEnd: true,
          currentPeriodEnd: periodEnd,
          membershipPlanId: 'plan-pro',
          exclusiveGroupKey: null,
          membershipPlan: { id: 'plan-pro', name: 'Pro', exclusiveGroup: null },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'cash-sched',
          status: SubscriptionStatus.SCHEDULED,
          source: SubscriptionSource.CASH,
          membershipPlanId: 'plan-pro',
          exclusiveGroupKey: null,
          membershipPlan: { id: 'plan-pro', exclusiveGroup: null },
          currentPeriodStart: periodEnd,
          currentPeriodEnd: new Date('2026-09-30T04:50:48.000Z'),
        },
      ]);
    prisma.payment.findFirst.mockResolvedValue({
      id: 'pay-existing',
      amountCents: 60000,
      status: 'SUCCEEDED',
      paymentMethod: 'CASH',
    });
    prisma.membershipPlan.findFirstOrThrow.mockResolvedValue({
      id: 'plan-pro',
      name: 'Pro',
      billingInterval: 'MONTHLY',
      priceCents: 60000,
      currency: 'mxn',
    });

    const result = await service.scheduleCashAtStripePeriodEnd({
      studioId: 'studio-1',
      actorUserId: 'admin-1',
      targetUserId: 'user-1',
      plan: {
        id: 'plan-pro',
        entitlementDays: null,
        classCredits: 5,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
      } as never,
      amountCents: 60000,
      notes: null,
      defaultPeriodEnd: (start) => new Date(start.getTime() + 30 * 86_400_000),
    });

    expect(result.payment.id).toBe('pay-existing');
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.subscription.create).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('cancelStripeImmediately is idempotent when Stripe already canceled remotely', async () => {
    prisma.subscription.findFirst.mockResolvedValue({
      id: 'stripe-local',
      stripeSubscriptionId: 'sub_1',
      status: SubscriptionStatus.ACTIVE,
      membershipPlan: { name: 'Pro' },
    });
    stripe.cancelSubscription.mockRejectedValue(new Error('Subscription already been canceled'));
    prisma.subscription.update.mockResolvedValue({ id: 'stripe-local' });

    await service.cancelStripeImmediately({ studioId: 'studio-1', userId: 'user-1' });
    expect(prisma.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'stripe-local' },
        data: expect.objectContaining({ status: SubscriptionStatus.CANCELED }),
      }),
    );
  });

  describe('MM-3 — family-scoped activation isolation (gate ON)', () => {
    beforeEach(() => {
      process.env['MULTI_MEMBERSHIP_ENABLED'] = 'true';
    });
    afterEach(() => {
      delete process.env['MULTI_MEMBERSHIP_ENABLED'];
    });

    const fullScheduledCash = {
      id: 'cash-sched-full',
      status: SubscriptionStatus.SCHEDULED,
      source: SubscriptionSource.CASH,
      membershipPlanId: 'plan-full',
      exclusiveGroupKey: 'CORE',
      membershipPlan: { id: 'plan-full', exclusiveGroup: 'CORE' },
    };
    const bootyStripeActive = {
      id: 'stripe-booty',
      status: SubscriptionStatus.ACTIVE,
      currentPeriodEnd: new Date(Date.now() - 86_400_000), // already ended
      stripeSubscriptionId: 'sub_booty',
      membershipPlanId: 'plan-booty',
      exclusiveGroupKey: null,
      membershipPlan: { id: 'plan-booty', exclusiveGroup: null },
    };

    it('a Booty Lab cancellation NEVER activates a Full Access cash successor (forPlan scoping)', async () => {
      prisma.subscription.findMany.mockResolvedValueOnce([fullScheduledCash]);

      const result = await service.activateScheduledCashIfDue(prisma as never, {
        studioId: 'studio-1',
        userId: 'user-1',
        now: new Date(),
        forPlan: { id: 'plan-booty', exclusiveGroup: null },
      });

      expect(result).toBeNull();
      expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('a Full Access successor is not activated while the FULL family Stripe sub is live, regardless of Booty state', async () => {
      const fullStripeActive = {
        id: 'stripe-full',
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: new Date(Date.now() + 86_400_000), // still running
        stripeSubscriptionId: 'sub_full',
        membershipPlanId: 'plan-full',
        exclusiveGroupKey: 'CORE',
        membershipPlan: { id: 'plan-full', exclusiveGroup: 'CORE' },
      };
      prisma.subscription.findMany
        .mockResolvedValueOnce([fullScheduledCash])
        .mockResolvedValueOnce([fullStripeActive, bootyStripeActive]);

      const result = await service.activateScheduledCashIfDue(prisma as never, {
        studioId: 'studio-1',
        userId: 'user-1',
        now: new Date(),
        forPlan: { id: 'plan-full', exclusiveGroup: 'CORE' },
      });

      // The ENDED Booty Stripe sub must not unlock the Full successor — only the Full
      // family's own Stripe sub matters, and it is still running.
      expect(result).toBeNull();
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('activating the Full successor cancels ONLY the Full-family Stripe sub, never the Booty one', async () => {
      const fullStripeEnded = {
        id: 'stripe-full',
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
        stripeSubscriptionId: 'sub_full',
        membershipPlanId: 'plan-full',
        exclusiveGroupKey: 'CORE',
        membershipPlan: { id: 'plan-full', exclusiveGroup: 'CORE' },
      };
      const bootyStripeLive = {
        ...bootyStripeActive,
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
      };
      prisma.subscription.findMany
        .mockResolvedValueOnce([fullScheduledCash])
        .mockResolvedValueOnce([fullStripeEnded, bootyStripeLive]);
      prisma.subscription.update.mockResolvedValue({ id: 'stripe-full' });
      prisma.subscription.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.subscription.findUniqueOrThrow = jest.fn().mockResolvedValue({
        id: 'cash-sched-full',
        status: SubscriptionStatus.ACTIVE,
      });

      const result = await service.activateScheduledCashIfDue(prisma as never, {
        studioId: 'studio-1',
        userId: 'user-1',
        now: new Date(),
        forPlan: { id: 'plan-full', exclusiveGroup: 'CORE' },
      });

      expect(result?.id).toBe('cash-sched-full');
      // Exactly one Stripe-side cancel, and it is the Full row — Booty is untouched.
      expect(prisma.subscription.update).toHaveBeenCalledTimes(1);
      expect(prisma.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'stripe-full' } }),
      );
    });

    it('scheduleCashAtStripePeriodEnd targets the Stripe sub in the SAME family as the plan being sold', async () => {
      const bootyStripeLive = {
        ...bootyStripeActive,
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
        cancelAtPeriodEnd: false,
      };
      const fullStripeLive = {
        id: 'stripe-full',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
        stripeSubscriptionId: 'sub_full',
        membershipPlanId: 'plan-full',
        exclusiveGroupKey: 'CORE',
        membershipPlan: { id: 'plan-full', name: 'Full', exclusiveGroup: 'CORE' },
      };
      // Conflict lookup for the FULL plan sale sees both; must pick the Full sub.
      prisma.subscription.findMany
        .mockResolvedValueOnce([bootyStripeLive, fullStripeLive])
        // findPendingScheduledCashForPlan → existing scheduled successor for Full
        .mockResolvedValueOnce([fullScheduledCash]);
      prisma.payment.findFirst.mockResolvedValue({
        id: 'pay-1', amountCents: 150000, status: 'SUCCEEDED', paymentMethod: 'CASH',
      });
      prisma.membershipPlan.findFirstOrThrow.mockResolvedValue({
        id: 'plan-full', name: 'Full', billingInterval: 'MONTHLY', priceCents: 150000, currency: 'mxn',
      });

      const result = await service.scheduleCashAtStripePeriodEnd({
        studioId: 'studio-1',
        actorUserId: 'admin-1',
        targetUserId: 'user-1',
        plan: { id: 'plan-full', exclusiveGroup: 'CORE', entitlementDays: null, billingInterval: 'MONTHLY' } as never,
        amountCents: 150000,
        notes: null,
        defaultPeriodEnd: (start) => new Date(start.getTime() + 30 * 86_400_000),
      });

      expect(result.stripe.stripeSubscriptionId).toBe('sub_full');
      expect(stripe.updateSubscription).not.toHaveBeenCalledWith('sub_booty', expect.anything(), expect.anything());
    });
  });
});
