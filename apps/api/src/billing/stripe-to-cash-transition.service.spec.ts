import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Role, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { StripeToCashTransitionService } from './stripe-to-cash-transition.service';

describe('StripeToCashTransitionService', () => {
  const stripe = {
    cancelSubscription: jest.fn(),
    updateSubscription: jest.fn(),
  };
  const prisma = {
    subscription: {
      findFirst: jest.fn(),
      findFirstOrThrow: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    payment: { findFirst: jest.fn(), create: jest.fn() },
    membershipPlan: { findFirstOrThrow: jest.fn() },
    membershipEntitlementCycle: { create: jest.fn() },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };

  let service: StripeToCashTransitionService;

  beforeEach(() => {
    jest.clearAllMocks();
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
    prisma.subscription.findFirst
      .mockResolvedValueOnce({
        id: 'cash-sched',
        status: SubscriptionStatus.SCHEDULED,
        source: SubscriptionSource.CASH,
      })
      .mockResolvedValueOnce({
        id: 'stripe-local',
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: future,
        stripeSubscriptionId: 'sub_1',
      });

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
    prisma.subscription.findFirst
      .mockResolvedValueOnce({
        id: 'cash-sched',
        status: SubscriptionStatus.SCHEDULED,
        source: SubscriptionSource.CASH,
      })
      .mockResolvedValueOnce({
        id: 'stripe-local',
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: past,
        stripeSubscriptionId: 'sub_1',
      });
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
    prisma.subscription.findFirst
      .mockResolvedValueOnce({
        id: 'stripe-local',
        stripeSubscriptionId: 'sub_1',
        status: SubscriptionStatus.ACTIVE,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: periodEnd,
        membershipPlanId: 'plan-pro',
        membershipPlan: { name: 'Pro' },
      })
      .mockResolvedValueOnce({
        id: 'cash-sched',
        status: SubscriptionStatus.SCHEDULED,
        source: SubscriptionSource.CASH,
        membershipPlanId: 'plan-pro',
        currentPeriodStart: periodEnd,
        currentPeriodEnd: new Date('2026-09-30T04:50:48.000Z'),
      });
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
});
