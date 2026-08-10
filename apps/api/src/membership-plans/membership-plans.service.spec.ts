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

  const service = new MembershipPlansService(prisma as never);

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
});
