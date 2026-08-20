import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  PaymentMethod,
  PaymentStatus,
  Role,
  SubscriptionSource,
  SubscriptionStatus,
} from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { BillingService } from '../billing/billing.service';
import { SubscriptionLifecycleService } from '../billing/subscription-lifecycle.service';
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
    subscription: { create: jest.Mock; update: jest.Mock; count: jest.Mock; updateMany: jest.Mock; findFirst: jest.Mock };
    membershipEntitlementCycle: { create: jest.Mock };
    payment: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let authService: { hashPassword: jest.Mock };
  let billingService: { createStaffInitiatedCheckoutSession: jest.Mock };
  let waiverService: { assertMemberWaiverAccepted: jest.Mock };
  let auditService: { log: jest.Mock };
  let salesSettingsService: { getSettings: jest.Mock };
  let subscriptionLifecycle: {
    assertNoRenewableSubscriptionConflict: jest.Mock;
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
      subscription: { create: jest.fn(), update: jest.fn(), count: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
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
    subscriptionLifecycle = {
      assertNoRenewableSubscriptionConflict: jest.fn().mockResolvedValue(undefined),
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
        { provide: SubscriptionLifecycleService, useValue: subscriptionLifecycle },
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
    prisma.subscription.count.mockResolvedValue(0);
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-1',
      studioId: 'studio-1',
      priceCents: 150000,
      currency: 'mxn',
      billingInterval: 'MONTHLY',
      name: 'Monthly',
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

  it('renews an expired cash membership with a new isolated entitlement period', async () => {
    mockActor(Role.ADMIN);
    prisma.subscription.count.mockResolvedValue(1);
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

    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: {
        studioId: 'studio-1',
        userId: 'member-1',
        status: { in: expect.arrayContaining([SubscriptionStatus.ACTIVE]) },
      },
      data: { status: SubscriptionStatus.CANCELED },
    });
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
      prisma.subscription.count.mockResolvedValue(0);
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
      prisma.subscription.count.mockResolvedValue(1);
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
