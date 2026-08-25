import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Role,
  SubscriptionEndReason,
  SubscriptionSource,
  SubscriptionStatus,
} from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { BillingService } from '../billing/billing.service';
import { StripeToCashTransitionService } from '../billing/stripe-to-cash-transition.service';
import { PrismaService } from '../prisma/prisma.service';
import { WaiverService } from '../waiver/waiver.service';
import { AuditService } from './audit.service';
import { SalesSettingsService } from './sales-settings.service';
import { SalesService } from './sales.service';

describe('SalesService', () => {
  let service: SalesService;
  let prisma: {
    studioMembership: { findFirst: jest.Mock; create: jest.Mock };
    user: { findFirst: jest.Mock; create: jest.Mock };
    membershipPlan: { findFirst: jest.Mock };
    subscription: { create: jest.Mock; update: jest.Mock; count: jest.Mock; updateMany: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock };
    membershipEntitlementCycle: { create: jest.Mock };
    payment: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let authService: { hashPassword: jest.Mock };
  let billingService: { createStaffInitiatedCheckoutSession: jest.Mock };
  let waiverService: { assertMemberWaiverAccepted: jest.Mock };
  let auditService: { log: jest.Mock };
  let salesSettingsService: { getSettings: jest.Mock };
  let stripeToCash: {
    findPrimaryStripeSubscription: jest.Mock;
    findPendingScheduledCash: jest.Mock;
    buildConflictException: jest.Mock;
    assertCanResolveStripe: jest.Mock;
    scheduleCashAtStripePeriodEnd: jest.Mock;
    cancelStripeImmediately: jest.Mock;
    reconcileScheduledCashForMember: jest.Mock;
  };

  const defaultSettings = {
    frontDeskCanCreateMember: true,
    frontDeskCanIssueCheckout: true,
    frontDeskCanRecordCash: false,
  };

  beforeEach(async () => {
    prisma = {
      studioMembership: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({
          id: 'membership-new',
          role: Role.MEMBER,
          createdAt: new Date(),
        }),
      },
      user: { findFirst: jest.fn(), create: jest.fn() },
      membershipPlan: { findFirst: jest.fn() },
      subscription: { create: jest.fn(), update: jest.fn(), count: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
      membershipEntitlementCycle: { create: jest.fn().mockResolvedValue({ id: 'cycle-1' }) },
      payment: { create: jest.fn() },
      $transaction: jest.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    };
    authService = { hashPassword: jest.fn().mockResolvedValue('hashed') };
    billingService = {
      createStaffInitiatedCheckoutSession: jest
        .fn()
        .mockResolvedValue({ action: 'checkout', url: 'https://checkout.stripe.test/session' }),
    };
    stripeToCash = {
      findPrimaryStripeSubscription: jest.fn().mockResolvedValue(null),
      findPendingScheduledCash: jest.fn().mockResolvedValue(null),
      buildConflictException: jest.fn(
        () =>
          new ConflictException({
            code: 'STRIPE_RENEWABLE_CONFLICT',
            message: 'Este miembro tiene una suscripción activa en Stripe.',
          }),
      ),
      assertCanResolveStripe: jest.fn(),
      scheduleCashAtStripePeriodEnd: jest.fn(),
      cancelStripeImmediately: jest.fn().mockResolvedValue(null),
      reconcileScheduledCashForMember: jest.fn().mockResolvedValue(false),
    };
    waiverService = { assertMemberWaiverAccepted: jest.fn().mockResolvedValue(undefined) };
    auditService = { log: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    salesSettingsService = { getSettings: jest.fn().mockResolvedValue(defaultSettings) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthService, useValue: authService },
        { provide: BillingService, useValue: billingService },
        { provide: StripeToCashTransitionService, useValue: stripeToCash },
        { provide: WaiverService, useValue: waiverService },
        { provide: AuditService, useValue: auditService },
        { provide: SalesSettingsService, useValue: salesSettingsService },
      ],
    }).compile();

    service = module.get(SalesService);
  });

  function mockActor(role: Role) {
    prisma.studioMembership.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      if (args.where.userId === 'actor') {
        return { id: 'actor-m', role };
      }
      if (args.where.userId === 'member-1' && args.where.role === Role.MEMBER) {
        return {
          id: 'member-m',
          role: Role.MEMBER,
          user: {
            id: 'member-1',
            email: 'member@test.com',
            firstName: 'Ana',
            lastName: 'Lopez',
            phone: null,
            createdAt: new Date(),
          },
        };
      }
      return null;
    });
  }

  it('creates a walk-in member and audit log', async () => {
    mockActor(Role.ADMIN);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user-new',
      email: 'new@test.com',
      firstName: 'New',
      lastName: 'Member',
      phone: null,
      createdAt: new Date(),
    });

    const result = await service.createWalkInMember('studio-1', 'actor', {
      email: 'new@test.com',
      firstName: 'New',
      lastName: 'Member',
      temporaryPassword: 'TempPass1!',
    });

    expect(result.user.id).toBe('user-new');
    expect(authService.hashPassword).toHaveBeenCalledWith('TempPass1!');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MEMBER_CREATED', targetUserId: 'user-new' }),
    );
  });

  it('rejects duplicate email on create member', async () => {
    mockActor(Role.ADMIN);
    prisma.user.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      service.createWalkInMember('studio-1', 'actor', {
        email: 'dup@test.com',
        firstName: 'Dup',
        lastName: 'User',
        temporaryPassword: 'TempPass1!',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('allows front desk to generate checkout when enabled', async () => {
    mockActor(Role.FRONT_DESK);

    const result = await service.createStaffCheckoutSession(
      'studio-1',
      'actor',
      'member-1',
      'plan-1',
    );

    expect(result.action).toBe('checkout');
    if (result.action === 'checkout') {
      expect(result.url).toContain('checkout.stripe.test');
    }
    expect(billingService.createStaffInitiatedCheckoutSession).toHaveBeenCalledWith({
      actorUserId: 'actor',
      targetUserId: 'member-1',
      studioId: 'studio-1',
      planId: 'plan-1',
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STAFF_CHECKOUT_CREATED' }),
    );
  });

  it('records cash subscription as admin with waiver', async () => {
    mockActor(Role.ADMIN);
    prisma.subscription.findMany.mockResolvedValue([]);
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-1',
      studioId: 'studio-1',
      priceCents: 150000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      name: 'Monthly',
      entitlementDays: null,
    });
    prisma.subscription.create.mockResolvedValue({
      id: 'sub-1',
      status: SubscriptionStatus.ACTIVE,
      source: SubscriptionSource.CASH,
      currentPeriodEnd: new Date('2026-08-01'),
      membershipPlan: { id: 'plan-1', name: 'Monthly' },
    });
    prisma.payment.create.mockResolvedValue({ id: 'pay-1' });

    const result = await service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
      planId: 'plan-1',
      amountCents: 150000,
      paymentMethod: 'CASH',
    });

    expect(waiverService.assertMemberWaiverAccepted).toHaveBeenCalledWith('studio-1', 'member-1');
    expect(prisma.subscription.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: SubscriptionSource.CASH,
          status: SubscriptionStatus.ACTIVE,
        }),
      }),
    );
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentMethod: PaymentMethod.CASH,
          status: PaymentStatus.SUCCEEDED,
          recordedByUserId: 'actor',
        }),
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CASH_SUBSCRIPTION_CREATED' }),
    );
    expect(result.subscription.id).toBe('sub-1');
  });

  it('omitted periodStart defaults to now (immediate entitlement; no UTC-noon client bug)', async () => {
    mockActor(Role.ADMIN);
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-25T01:41:00.000Z'));
    try {
      prisma.membershipPlan.findFirst.mockResolvedValue({
        id: 'plan-1',
        studioId: 'studio-1',
        priceCents: 100000,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
        name: 'Basic Access',
        entitlementDays: null,
        classCredits: 12,
      });
      prisma.subscription.findMany.mockResolvedValue([]);
      prisma.subscription.create.mockResolvedValue({
        id: 'sub-now',
        status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.CASH,
        currentPeriodStart: new Date('2026-08-25T01:41:00.000Z'),
        currentPeriodEnd: new Date('2026-09-25T01:41:00.000Z'),
        membershipPlan: { id: 'plan-1', name: 'Basic Access' },
      });
      prisma.payment.create.mockResolvedValue({ id: 'pay-now' });

      await service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
        planId: 'plan-1',
        amountCents: 100000,
        paymentMethod: 'CASH',
      });

      const createData = prisma.subscription.create.mock.calls[0][0].data;
      expect(createData.currentPeriodStart.toISOString()).toBe('2026-08-25T01:41:00.000Z');
      expect(createData.currentPeriodStart.getTime()).toBeLessThanOrEqual(Date.now());
      expect(createData.currentPeriodEnd.toISOString()).toBe('2026-09-25T01:41:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('renews ACTIVE interval CASH same-plan by superseding before create (no P2002)', async () => {
    mockActor(Role.ADMIN);
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-basic',
      studioId: 'studio-1',
      priceCents: 100000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      name: 'Basic Access',
      entitlementDays: null,
      classCredits: 12,
    });
    prisma.subscription.findMany.mockResolvedValue([
      { id: 'sub-alvaro-old', membershipPlanId: 'plan-basic' },
    ]);
    prisma.subscription.update.mockResolvedValue({});
    prisma.subscription.updateMany.mockResolvedValue({ count: 1 });
    const renewedStart = new Date('2026-08-24T18:00:00.000Z');
    const renewedEnd = new Date('2026-09-24T05:59:59.000Z');
    prisma.subscription.create.mockResolvedValue({
      id: 'sub-alvaro-new',
      status: SubscriptionStatus.ACTIVE,
      source: SubscriptionSource.CASH,
      currentPeriodStart: renewedStart,
      currentPeriodEnd: renewedEnd,
      membershipPlan: { id: 'plan-basic', name: 'Basic Access', priceCents: 100000, currency: 'mxn', billingInterval: 'MONTHLY' },
    });
    prisma.payment.create.mockResolvedValue({
      id: 'pay-renew',
      amountCents: 100000,
      status: PaymentStatus.SUCCEEDED,
      paymentMethod: PaymentMethod.CASH,
    });

    const result = await service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
      planId: 'plan-basic',
      amountCents: 100000,
      paymentMethod: 'CASH',
      periodStart: renewedStart.toISOString(),
      periodEnd: renewedEnd.toISOString(),
    });

    const updateOrder = prisma.subscription.update.mock.invocationCallOrder[0];
    const createOrder = prisma.subscription.create.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(createOrder);

    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-alvaro-old' },
      data: {
        status: SubscriptionStatus.CANCELED,
        endReason: SubscriptionEndReason.SUPERSEDED_RENEWAL,
      },
    });
    expect(prisma.subscription.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentPeriodStart: renewedStart,
          currentPeriodEnd: renewedEnd,
          status: SubscriptionStatus.ACTIVE,
          membershipPlanId: 'plan-basic',
        }),
      }),
    );
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['sub-alvaro-old'] } },
      data: { supersededBySubscriptionId: 'sub-alvaro-new' },
    });
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CASH_SUBSCRIPTION_CREATED',
        entityId: 'sub-alvaro-new',
      }),
    );
    expect(result.subscription.id).toBe('sub-alvaro-new');
  });

  it('cash plan change supersedes prior ACTIVE CASH with SUPERSEDED_PLAN_CHANGE before create', async () => {
    mockActor(Role.ADMIN);
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-pro',
      studioId: 'studio-1',
      priceCents: 60000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      name: 'Pro',
      entitlementDays: null,
    });
    prisma.subscription.findMany.mockResolvedValue([
      { id: 'sub-basic', membershipPlanId: 'plan-basic' },
    ]);
    prisma.subscription.update.mockResolvedValue({});
    prisma.subscription.updateMany.mockResolvedValue({ count: 1 });
    prisma.subscription.create.mockResolvedValue({
      id: 'sub-pro',
      status: SubscriptionStatus.ACTIVE,
      source: SubscriptionSource.CASH,
      membershipPlan: { id: 'plan-pro', name: 'Pro' },
    });
    prisma.payment.create.mockResolvedValue({ id: 'pay-pro' });

    await service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
      planId: 'plan-pro',
      amountCents: 60000,
      paymentMethod: 'CASH',
    });

    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-basic' },
      data: {
        status: SubscriptionStatus.CANCELED,
        endReason: SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE,
      },
    });
    expect(prisma.subscription.create).toHaveBeenCalled();
  });

  it('maps P2002 active-membership races to ConflictException (not 500)', async () => {
    mockActor(Role.ADMIN);
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-1',
      studioId: 'studio-1',
      priceCents: 100000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      name: 'Basic',
      entitlementDays: null,
    });
    prisma.subscription.findMany.mockResolvedValue([]);
    prisma.subscription.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { target: ['studio_id', 'user_id'] },
      }),
    );

    await expect(
      service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
        planId: 'plan-1',
        amountCents: 100000,
        paymentMethod: 'CASH',
      }),
    ).rejects.toThrow(ConflictException);

    await expect(
      service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
        planId: 'plan-1',
        amountCents: 100000,
        paymentMethod: 'CASH',
      }),
    ).rejects.toThrow(/membresía activa/i);
  });

  it('preserves Stripe conflict gate (ACTIVE Stripe → Cash without stripeResolution)', async () => {
    mockActor(Role.ADMIN);
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-1',
      studioId: 'studio-1',
      priceCents: 60000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      name: 'Pro',
      entitlementDays: null,
    });
    stripeToCash.findPrimaryStripeSubscription.mockResolvedValue({
      id: 'stripe-local',
      stripeSubscriptionId: 'sub_x',
      membershipPlanId: 'plan-1',
      membershipPlan: { name: 'Pro' },
      status: SubscriptionStatus.ACTIVE,
      cancelAtPeriodEnd: false,
      currentPeriodStart: new Date('2026-07-30T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-08-30T00:00:00.000Z'),
    });
    stripeToCash.buildConflictException.mockReturnValue(
      new ConflictException({
        code: 'STRIPE_RENEWABLE_CONFLICT',
        message: 'Este miembro tiene una suscripción activa en Stripe.',
      }),
    );

    await expect(
      service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
        planId: 'plan-1',
        amountCents: 60000,
        paymentMethod: 'CASH',
      }),
    ).rejects.toThrow(/suscripción activa en Stripe/i);

    expect(prisma.subscription.create).not.toHaveBeenCalled();
  });

  it('preserves Stripe conflict gate for PAST_DUE Stripe without stripeResolution', async () => {
    mockActor(Role.ADMIN);
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-1',
      studioId: 'studio-1',
      priceCents: 60000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      name: 'Pro',
      entitlementDays: null,
    });
    stripeToCash.findPrimaryStripeSubscription.mockResolvedValue({
      id: 'stripe-local',
      stripeSubscriptionId: 'sub_x',
      membershipPlanId: 'plan-1',
      membershipPlan: { name: 'Pro' },
      status: SubscriptionStatus.PAST_DUE,
      cancelAtPeriodEnd: false,
      currentPeriodStart: new Date('2026-07-30T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-08-30T00:00:00.000Z'),
    });
    stripeToCash.buildConflictException.mockReturnValue(
      new ConflictException({
        code: 'STRIPE_RENEWABLE_CONFLICT',
        message: 'Este miembro tiene una suscripción activa en Stripe.',
      }),
    );

    await expect(
      service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
        planId: 'plan-1',
        amountCents: 60000,
        paymentMethod: 'CASH',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('schedules period-end Stripe→Cash without creating ACTIVE cash today', async () => {
    mockActor(Role.ADMIN);
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-1',
      studioId: 'studio-1',
      priceCents: 60000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      name: 'Pro',
      entitlementDays: null,
    });
    stripeToCash.findPrimaryStripeSubscription.mockResolvedValue({
      id: 'stripe-local',
      stripeSubscriptionId: 'sub_x',
      membershipPlanId: 'plan-1',
      membershipPlan: { name: 'Pro' },
      status: SubscriptionStatus.ACTIVE,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date('2026-08-30T04:50:48.000Z'),
    });
    stripeToCash.scheduleCashAtStripePeriodEnd.mockResolvedValue({
      subscription: {
        id: 'cash-sched',
        status: SubscriptionStatus.SCHEDULED,
        source: SubscriptionSource.CASH,
        currentPeriodStart: new Date('2026-08-30T04:50:48.000Z'),
        currentPeriodEnd: new Date('2026-09-30T04:50:48.000Z'),
        membershipPlan: { id: 'plan-1', name: 'Pro', billingInterval: 'MONTHLY', priceCents: 60000, currency: 'mxn' },
      },
      payment: {
        id: 'pay-1',
        amountCents: 60000,
        status: PaymentStatus.SUCCEEDED,
        paymentMethod: PaymentMethod.CASH,
      },
      stripe: {
        localSubscriptionId: 'stripe-local',
        stripeSubscriptionId: 'sub_x',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date('2026-08-30T04:50:48.000Z'),
      },
    });

    const result = await service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
      planId: 'plan-1',
      amountCents: 60000,
      paymentMethod: 'CASH',
      stripeResolution: 'cancel_at_period_end',
    });

    expect(stripeToCash.assertCanResolveStripe).toHaveBeenCalledWith(Role.ADMIN);
    expect(stripeToCash.scheduleCashAtStripePeriodEnd).toHaveBeenCalled();
    expect(prisma.subscription.create).not.toHaveBeenCalled();
    expect(result.subscription.status).toBe(SubscriptionStatus.SCHEDULED);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STRIPE_TO_CASH_PERIOD_END_SCHEDULED' }),
    );
  });

  it('forbids FRONT_DESK from Stripe resolution mutations', async () => {
    mockActor(Role.FRONT_DESK);
    salesSettingsService.getSettings.mockResolvedValue({
      ...defaultSettings,
      frontDeskCanRecordCash: true,
    });
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-1',
      studioId: 'studio-1',
      priceCents: 60000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      name: 'Pro',
      entitlementDays: null,
    });
    stripeToCash.findPrimaryStripeSubscription.mockResolvedValue({
      id: 'stripe-local',
      stripeSubscriptionId: 'sub_x',
      membershipPlanId: 'plan-1',
      membershipPlan: { name: 'Pro' },
      status: SubscriptionStatus.ACTIVE,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: new Date('2026-08-30T04:50:48.000Z'),
    });
    stripeToCash.assertCanResolveStripe.mockImplementation(() => {
      throw new ForbiddenException(
        'Only OWNER or ADMIN can change a Stripe subscription to cash.',
      );
    });

    await expect(
      service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
        planId: 'plan-1',
        amountCents: 60000,
        paymentMethod: 'CASH',
        stripeResolution: 'cancel_at_period_end',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('renews canceled/non-renewable interval cash with a new isolated period', async () => {
    mockActor(Role.ADMIN);
    prisma.subscription.findMany.mockResolvedValue([]);
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-1',
      studioId: 'studio-1',
      priceCents: 150000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      name: 'Monthly',
      entitlementDays: null,
    });
    prisma.subscription.create.mockResolvedValue({
      id: 'sub-renewed',
      status: SubscriptionStatus.ACTIVE,
      source: SubscriptionSource.CASH,
      currentPeriodEnd: new Date('2026-09-19T18:00:00.000Z'),
      membershipPlan: { id: 'plan-1', name: 'Monthly' },
    });
    prisma.payment.create.mockResolvedValue({ id: 'pay-renewed' });
    const renewedStart = new Date('2026-08-19T18:00:00.000Z');

    await service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
      planId: 'plan-1',
      amountCents: 150000,
      paymentMethod: 'CASH',
      periodStart: renewedStart.toISOString(),
    });

    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(prisma.subscription.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentPeriodStart: renewedStart,
          currentPeriodEnd: new Date('2026-09-19T18:00:00.000Z'),
          status: SubscriptionStatus.ACTIVE,
        }),
      }),
    );
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ subscriptionId: 'sub-renewed' }) }),
    );
  });

  it('denies cash for front desk by default', async () => {
    mockActor(Role.FRONT_DESK);

    await expect(
      service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
        planId: 'plan-1',
        amountCents: 150000,
        paymentMethod: 'CASH',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('requires waiver for cash membership', async () => {
    mockActor(Role.ADMIN);
    waiverService.assertMemberWaiverAccepted.mockRejectedValue(
      new ForbiddenException('Waiver required'),
    );

    await expect(
      service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
        planId: 'plan-1',
        amountCents: 150000,
        paymentMethod: 'CASH',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  describe('createOfflineSubscription — fixed-duration plan (entitlementDays)', () => {
    const periodStart = new Date('2026-08-18T18:00:00.000Z');

    beforeEach(() => {
      mockActor(Role.ADMIN);
      prisma.subscription.findMany.mockResolvedValue([]);
      prisma.membershipPlan.findFirst.mockResolvedValue({
        id: 'plan-booty',
        studioId: 'studio-1',
        priceCents: 80000,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
        name: 'Booty Lab',
        entitlementDays: 45,
        classCredits: 4,
      });
      prisma.subscription.create.mockResolvedValue({
        id: 'sub-booty',
        status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.CASH,
        currentPeriodEnd: new Date('2026-09-18T18:00:00.000Z'),
        membershipPlan: { id: 'plan-booty', name: 'Booty Lab' },
      });
      prisma.payment.create.mockResolvedValue({ id: 'pay-1' });
    });

    it('sets entitlementEndsAt = periodStart + entitlementDays when plan has entitlementDays', async () => {
      await service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
        planId: 'plan-booty',
        amountCents: 80000,
        paymentMethod: 'CASH',
        periodStart: periodStart.toISOString(),
      });

      const expectedEntitlementEndsAt = new Date(
        periodStart.getTime() + 45 * 86_400_000,
      );

      expect(prisma.subscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entitlementEndsAt: expectedEntitlementEndsAt,
          }),
        }),
      );
    });

    it('does not set entitlementEndsAt when plan has no entitlementDays', async () => {
      prisma.membershipPlan.findFirst.mockResolvedValue({
        id: 'plan-regular',
        studioId: 'studio-1',
        priceCents: 150000,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
        name: 'Monthly',
        entitlementDays: null,
      });
      prisma.subscription.create.mockResolvedValue({
        id: 'sub-1',
        status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.CASH,
        currentPeriodEnd: new Date('2026-09-18T00:00:00.000Z'),
        membershipPlan: { id: 'plan-regular', name: 'Monthly' },
      });

      await service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
        planId: 'plan-regular',
        amountCents: 150000,
        paymentMethod: 'CASH',
      });

      const createCall = prisma.subscription.create.mock.calls[0][0];
      expect(createCall.data).not.toHaveProperty('entitlementEndsAt');
    });

    it('always sets cancelAtPeriodEnd=true for offline subscriptions', async () => {
      await service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
        planId: 'plan-booty',
        amountCents: 80000,
        paymentMethod: 'CASH',
      });

      expect(prisma.subscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cancelAtPeriodEnd: true }),
        }),
      );
    });

    it('queues a cash renewal after the current 45-day cycle without overlap', async () => {
      const currentEnd = new Date('2026-10-02T18:00:00.000Z');
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'sub-current-booty',
        currentPeriodStart: periodStart,
        currentPeriodEnd: currentEnd,
        entitlementEndsAt: currentEnd,
      });
      prisma.subscription.update.mockResolvedValue({
        id: 'sub-current-booty',
        status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.CASH,
        membershipPlan: { id: 'plan-booty', name: 'Booty Lab' },
      });

      await service.createOfflineSubscription('studio-1', 'actor', 'member-1', {
        planId: 'plan-booty', amountCents: 80000, paymentMethod: 'CASH',
      });

      expect(prisma.membershipEntitlementCycle.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          startsAt: currentEnd,
          endsAt: new Date(currentEnd.getTime() + 45 * 86_400_000),
          creditLimit: 4,
        }),
      });
      expect(prisma.subscription.create).not.toHaveBeenCalled();
      expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
      expect(prisma.subscription.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'sub-current-booty' },
        data: expect.objectContaining({
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: periodStart,
          entitlementEndsAt: new Date(currentEnd.getTime() + 45 * 86_400_000),
        }),
      }));
    });
  });
});
