import { BadRequestException } from '@nestjs/common';
import { BillingInterval } from '@prisma/client';
import { MembershipPlansService } from './membership-plans.service';

describe('MembershipPlansService class access', () => {
  const prisma = {
    studio: { findFirst: jest.fn() },
    classTemplate: { findMany: jest.fn() },
    membershipPlan: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    membershipPlanClassAccess: {
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new MembershipPlansService(prisma as never, audit as never);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.studio.findFirst.mockResolvedValue({ id: 'studio-1' });
  });

  it('creates plan with all-class access', async () => {
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    prisma.membershipPlan.create.mockResolvedValue({ id: 'plan-1' });
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      studioId: 'studio-1',
      name: 'Unlimited',
      allClassesAccess: true,
      classTemplateAccess: [],
    });

    const result = await service.createPlan('studio-1', {
      name: 'Unlimited',
      priceCents: 1000,
      billingInterval: BillingInterval.MONTHLY,
      allClassesAccess: true,
      classTemplateIds: [],
    });

    expect(prisma.membershipPlanClassAccess.createMany).not.toHaveBeenCalled();
    expect(result.classAccess.allClasses).toBe(true);
  });

  it('creates restricted plan with three class templates', async () => {
    prisma.classTemplate.findMany.mockResolvedValue([
      { id: 't1' },
      { id: 't2' },
      { id: 't3' },
    ]);
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    prisma.membershipPlan.create.mockResolvedValue({ id: 'plan-2' });
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-2',
      studioId: 'studio-1',
      name: 'Flex',
      allClassesAccess: false,
      classTemplateAccess: [
        {
          classTemplate: {
            id: 't1',
            name: 'Push',
            durationMinutes: 60,
            deletedAt: null,
          },
        },
        {
          classTemplate: {
            id: 't2',
            name: 'Pull',
            durationMinutes: 60,
            deletedAt: null,
          },
        },
        {
          classTemplate: {
            id: 't3',
            name: 'Legs',
            durationMinutes: 60,
            deletedAt: null,
          },
        },
      ],
    });

    const result = await service.createPlan('studio-1', {
      name: 'Flex',
      priceCents: 800,
      billingInterval: BillingInterval.MONTHLY,
      allClassesAccess: false,
      classTemplateIds: ['t1', 't2', 't3'],
    });

    expect(prisma.membershipPlanClassAccess.createMany).toHaveBeenCalledWith({
      data: [
        { studioId: 'studio-1', membershipPlanId: 'plan-2', classTemplateId: 't1' },
        { studioId: 'studio-1', membershipPlanId: 'plan-2', classTemplateId: 't2' },
        { studioId: 'studio-1', membershipPlanId: 'plan-2', classTemplateId: 't3' },
      ],
    });
    expect(result.classAccess.templates).toHaveLength(3);
  });

  it('rejects template from another studio', async () => {
    prisma.classTemplate.findMany.mockResolvedValue([{ id: 't1' }]);

    await expect(
      service.createPlan('studio-1', {
        name: 'Bad',
        priceCents: 500,
        billingInterval: BillingInterval.MONTHLY,
        allClassesAccess: false,
        classTemplateIds: ['t1', 'foreign-t2'],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects duplicate template IDs', async () => {
    await expect(
      service.createPlan('studio-1', {
        name: 'Dup',
        priceCents: 500,
        billingInterval: BillingInterval.MONTHLY,
        allClassesAccess: false,
        classTemplateIds: ['t1', 't1'],
      }),
    ).rejects.toThrow(/Duplicate class template IDs/i);
  });

  it('updates plan by replacing class access rows', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-1',
      studioId: 'studio-1',
      allClassesAccess: false,
      allowedCategories: [],
      classTemplateAccess: [{ classTemplateId: 't1' }],
    });
    prisma.classTemplate.findMany.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      studioId: 'studio-1',
      allClassesAccess: false,
      classTemplateAccess: [
        {
          classTemplate: {
            id: 't1',
            name: 'Push',
            durationMinutes: 60,
            deletedAt: null,
          },
        },
        {
          classTemplate: {
            id: 't2',
            name: 'Pull',
            durationMinutes: 60,
            deletedAt: null,
          },
        },
      ],
    });

    await service.updatePlan('studio-1', 'plan-1', {
      classTemplateIds: ['t1', 't2'],
    });

    expect(prisma.membershipPlanClassAccess.deleteMany).toHaveBeenCalledWith({
      where: { membershipPlanId: 'plan-1' },
    });
    expect(prisma.membershipPlanClassAccess.createMany).toHaveBeenCalled();
  });

  it('creates a fixed-duration plan with entitlementDays', async () => {
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    prisma.classTemplate.findMany.mockResolvedValue([{ id: 't1' }]);
    prisma.membershipPlan.create.mockResolvedValue({ id: 'plan-booty' });
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-booty',
      studioId: 'studio-1',
      name: 'Booty Lab by Etzia',
      entitlementDays: 45,
      allClassesAccess: false,
      classTemplateAccess: [
        { classTemplate: { id: 't1', name: 'Booty Lab', durationMinutes: 45, deletedAt: null } },
      ],
    });

    await service.createPlan('studio-1', {
      name: 'Booty Lab by Etzia',
      priceCents: 90000,
      billingInterval: BillingInterval.MONTHLY,
      classCredits: 4,
      entitlementDays: 45,
      allClassesAccess: false,
      classTemplateIds: ['t1'],
    });

    expect(prisma.membershipPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entitlementDays: 45 }) }),
    );
  });

  it('omitting entitlementDays on create persists null (recurring plan)', async () => {
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    prisma.membershipPlan.create.mockResolvedValue({ id: 'plan-1' });
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-1',
      studioId: 'studio-1',
      name: 'Basic',
      entitlementDays: null,
      allClassesAccess: true,
      classTemplateAccess: [],
    });

    await service.createPlan('studio-1', {
      name: 'Basic',
      priceCents: 1000,
      billingInterval: BillingInterval.MONTHLY,
      allClassesAccess: true,
      classTemplateIds: [],
    });

    expect(prisma.membershipPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entitlementDays: null }) }),
    );
  });

  it('updates entitlementDays on an existing plan', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-booty',
      studioId: 'studio-1',
      allClassesAccess: false,
      allowedCategories: [],
      classTemplateAccess: [{ classTemplateId: 't1' }],
    });
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-booty',
      studioId: 'studio-1',
      entitlementDays: 45,
      allClassesAccess: false,
      classTemplateAccess: [
        { classTemplate: { id: 't1', name: 'Booty Lab', durationMinutes: 45, deletedAt: null } },
      ],
    });

    await service.updatePlan('studio-1', 'plan-booty', { entitlementDays: 45 });

    expect(prisma.membershipPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entitlementDays: 45 }) }),
    );
  });

  it('not passing entitlementDays on update leaves it untouched', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-booty',
      studioId: 'studio-1',
      allClassesAccess: false,
      allowedCategories: [],
      classTemplateAccess: [{ classTemplateId: 't1' }],
    });
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      id: 'plan-booty',
      studioId: 'studio-1',
      entitlementDays: 45,
      allClassesAccess: false,
      classTemplateAccess: [
        { classTemplate: { id: 't1', name: 'Booty Lab', durationMinutes: 45, deletedAt: null } },
      ],
    });

    await service.updatePlan('studio-1', 'plan-booty', { priceCents: 95000 });

    const updateCall = prisma.membershipPlan.update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('entitlementDays');
  });
});
