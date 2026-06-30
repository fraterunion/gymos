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
    subscription: { create: jest.Mock };
    payment: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let authService: { hashPassword: jest.Mock };
  let billingService: { createStaffInitiatedCheckoutSession: jest.Mock };
  let waiverService: { assertMemberWaiverAccepted: jest.Mock };
  let auditService: { log: jest.Mock };
  let salesSettingsService: { getSettings: jest.Mock };

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
      subscription: { create: jest.fn() },
      payment: { create: jest.fn() },
      $transaction: jest.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    };
    authService = { hashPassword: jest.fn().mockResolvedValue('hashed') };
    billingService = {
      createStaffInitiatedCheckoutSession: jest
        .fn()
        .mockResolvedValue({ checkoutUrl: 'https://checkout.stripe.test/session' }),
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

    expect(result.checkoutUrl).toContain('checkout.stripe.test');
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
});
