import { BadRequestException, NotFoundException } from '@nestjs/common';
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
  const stripe = {
    createRecurringPrice: jest.fn(),
    createProductForPlan: jest.fn(),
    retrievePrice: jest.fn(),
    deactivatePrice: jest.fn().mockResolvedValue({}),
  };
  const service = new MembershipPlansService(prisma as never, audit as never, stripe as never);

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
      priceCents: 1000,
      currency: 'usd',
      billingInterval: BillingInterval.MONTHLY,
      entitlementDays: null,
      stripeProductId: null,
      stripePriceId: null,
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
      priceCents: 90000,
      currency: 'mxn',
      billingInterval: BillingInterval.MONTHLY,
      entitlementDays: null,
      stripeProductId: null,
      stripePriceId: null,
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

    expect(stripe.createRecurringPrice).not.toHaveBeenCalled();
    expect(prisma.membershipPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ entitlementDays: 45 }) }),
    );
  });

  it('not passing entitlementDays on update leaves it untouched', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-booty',
      studioId: 'studio-1',
      priceCents: 90000,
      currency: 'mxn',
      billingInterval: BillingInterval.MONTHLY,
      entitlementDays: 45,
      stripeProductId: null,
      stripePriceId: null,
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

describe('MembershipPlansService Stripe price rotation', () => {
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
  const stripe = {
    createRecurringPrice: jest.fn(),
    createProductForPlan: jest.fn(),
    retrievePrice: jest.fn(),
    deactivatePrice: jest.fn().mockResolvedValue({}),
    updateSubscription: jest.fn(),
    cancelSubscription: jest.fn(),
    scheduleSubscriptionPriceChangeAtPeriodEnd: jest.fn(),
  };
  const service = new MembershipPlansService(prisma as never, audit as never, stripe as never);

  const basePlan = {
    id: 'plan-basic',
    studioId: 'studio-1',
    name: 'Basic Access',
    priceCents: 130000,
    currency: 'mxn',
    billingInterval: BillingInterval.MONTHLY,
    entitlementDays: null,
    stripeProductId: 'prod_basic',
    stripePriceId: 'price_old_1300',
    allClassesAccess: true,
    allowedCategories: [],
    classTemplateAccess: [],
    description: null,
    classCredits: null,
    active: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    stripe.deactivatePrice.mockResolvedValue({});
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
  });

  it('does not create a Stripe Price when financial fields are unchanged', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(basePlan);
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      ...basePlan,
      classTemplateAccess: [],
    });

    await service.updatePlan('studio-1', 'plan-basic', {
      description: 'Updated copy',
      priceCents: 130000,
    }, 'admin-1');

    expect(stripe.createRecurringPrice).not.toHaveBeenCalled();
    expect(prisma.membershipPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ description: 'Updated copy' }),
      }),
    );
  });

  it('rotates Stripe Price on 1300 → 1000 and updates GymOS stripePriceId', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(basePlan);
    stripe.createRecurringPrice.mockResolvedValue({ id: 'price_new_1000' });
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      ...basePlan,
      priceCents: 100000,
      stripePriceId: 'price_new_1000',
      classTemplateAccess: [],
    });

    const result = await service.updatePlan(
      'studio-1',
      'plan-basic',
      { priceCents: 100000 },
      'admin-1',
    );

    expect(stripe.createRecurringPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'prod_basic',
        unitAmount: 100000,
        currency: 'mxn',
        interval: 'month',
        metadata: expect.objectContaining({
          gymosPlanId: 'plan-basic',
          previousStripePriceId: 'price_old_1300',
          intendedPriceCents: '100000',
          source: 'membership_plan_edit',
        }),
      }),
      expect.objectContaining({
        idempotencyKey: 'plan-price:plan-basic:100000:mxn:month:1',
      }),
    );
    expect(prisma.membershipPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          priceCents: 100000,
          stripePriceId: 'price_new_1000',
          stripeProductId: 'prod_basic',
        }),
      }),
    );
    expect(stripe.deactivatePrice).toHaveBeenCalledWith('price_old_1300');
    expect(result.stripePriceId).toBe('price_new_1000');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          stripePriceRotated: true,
          previousStripePriceId: 'price_old_1300',
          newStripePriceId: 'price_new_1000',
          oldPriceCents: 130000,
          newPriceCents: 100000,
        }),
      }),
    );
  });

  it('leaves GymOS unchanged when Stripe Price create fails', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(basePlan);
    stripe.createRecurringPrice.mockRejectedValue(new Error('stripe down'));

    await expect(
      service.updatePlan('studio-1', 'plan-basic', { priceCents: 100000 }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.membershipPlan.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('retries with the same idempotency key after DB failure (no uncontrolled duplicates)', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(basePlan);
    stripe.createRecurringPrice.mockResolvedValue({ id: 'price_new_1000' });
    prisma.$transaction
      .mockRejectedValueOnce(new Error('db down'))
      .mockImplementationOnce(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      ...basePlan,
      priceCents: 100000,
      stripePriceId: 'price_new_1000',
      classTemplateAccess: [],
    });

    await expect(
      service.updatePlan('studio-1', 'plan-basic', { priceCents: 100000 }, 'admin-1'),
    ).rejects.toThrow('db down');

    // Retry succeeds; Stripe called again with same idempotency key (Stripe returns same Price).
    await service.updatePlan('studio-1', 'plan-basic', { priceCents: 100000 }, 'admin-1');

    expect(stripe.createRecurringPrice).toHaveBeenCalledTimes(2);
    const keys = stripe.createRecurringPrice.mock.calls.map((c) => c[1]?.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe('plan-price:plan-basic:100000:mxn:month:1');
  });

  it('does not rotate Price for cash-only plans (no Stripe ids)', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      ...basePlan,
      stripeProductId: null,
      stripePriceId: null,
    });
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      ...basePlan,
      stripeProductId: null,
      stripePriceId: null,
      priceCents: 100000,
      classTemplateAccess: [],
    });

    await service.updatePlan('studio-1', 'plan-basic', { priceCents: 100000 });

    expect(stripe.createRecurringPrice).not.toHaveBeenCalled();
    expect(prisma.membershipPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ priceCents: 100000 }) }),
    );
  });

  it('ignores client-supplied stale stripePriceId during rotation', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(basePlan);
    stripe.createRecurringPrice.mockResolvedValue({ id: 'price_new_1000' });
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      ...basePlan,
      priceCents: 100000,
      stripePriceId: 'price_new_1000',
      classTemplateAccess: [],
    });

    await service.updatePlan('studio-1', 'plan-basic', {
      priceCents: 100000,
      stripePriceId: 'price_old_1300',
    });

    expect(prisma.membershipPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stripePriceId: 'price_new_1000' }),
      }),
    );
  });

  it('does not mutate existing Stripe subscriptions when rotating sale Price', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(basePlan);
    stripe.createRecurringPrice.mockResolvedValue({ id: 'price_new_1000' });
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      ...basePlan,
      priceCents: 100000,
      stripePriceId: 'price_new_1000',
      classTemplateAccess: [],
    });

    await service.updatePlan('studio-1', 'plan-basic', { priceCents: 100000 }, 'admin-1');

    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
    expect(stripe.scheduleSubscriptionPriceChangeAtPeriodEnd).not.toHaveBeenCalled();
  });

  it('keeps new Price cutover when old Price deactivation fails', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(basePlan);
    stripe.createRecurringPrice.mockResolvedValue({ id: 'price_new_1000' });
    stripe.deactivatePrice.mockRejectedValue(new Error('stripe archive failed'));
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      ...basePlan,
      priceCents: 100000,
      stripePriceId: 'price_new_1000',
      classTemplateAccess: [],
    });

    const result = await service.updatePlan(
      'studio-1',
      'plan-basic',
      { priceCents: 100000 },
      'admin-1',
    );

    expect(result.stripePriceId).toBe('price_new_1000');
    expect(prisma.membershipPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stripePriceId: 'price_new_1000' }),
      }),
    );
    expect(stripe.deactivatePrice).toHaveBeenCalledWith('price_old_1300');
  });

  it('rotates Stripe Price when entitlementDays changes (maps to day interval)', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      ...basePlan,
      priceCents: 80000,
      stripePriceId: 'price_monthly',
    });
    stripe.createRecurringPrice.mockResolvedValue({ id: 'price_day_45' });
    prisma.membershipPlan.findUniqueOrThrow.mockResolvedValue({
      ...basePlan,
      priceCents: 80000,
      entitlementDays: 45,
      stripePriceId: 'price_day_45',
      classTemplateAccess: [],
    });

    await service.updatePlan('studio-1', 'plan-basic', { entitlementDays: 45 }, 'admin-1');

    expect(stripe.createRecurringPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        unitAmount: 80000,
        interval: 'day',
        intervalCount: 45,
      }),
      expect.objectContaining({
        idempotencyKey: 'plan-price:plan-basic:80000:mxn:day:45',
      }),
    );
    expect(prisma.membershipPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entitlementDays: 45,
          stripePriceId: 'price_day_45',
        }),
      }),
    );
  });
});

describe('MembershipPlansService.reconcileStripeSalePrice', () => {
  const prisma = {
    membershipPlan: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const stripe = {
    createRecurringPrice: jest.fn(),
    createProductForPlan: jest.fn(),
    retrievePrice: jest.fn(),
    deactivatePrice: jest.fn().mockResolvedValue({}),
    updateSubscription: jest.fn(),
    cancelSubscription: jest.fn(),
    scheduleSubscriptionPriceChangeAtPeriodEnd: jest.fn(),
  };
  const service = new MembershipPlansService(prisma as never, audit as never, stripe as never);

  const basePlan = {
    id: 'plan-basic',
    studioId: 'studio-1',
    name: 'Basic Access',
    priceCents: 100000,
    currency: 'mxn',
    billingInterval: BillingInterval.MONTHLY,
    entitlementDays: null,
    stripeProductId: 'prod_basic',
    stripePriceId: 'price_old_1300',
    allClassesAccess: true,
    allowedCategories: [],
    classTemplateAccess: [],
    description: null,
    classCredits: null,
    active: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    stripe.deactivatePrice.mockResolvedValue({});
  });

  it('returns already_synced without Stripe create or DB mutation when Price matches', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(basePlan);
    stripe.retrievePrice.mockResolvedValue({
      id: 'price_old_1300',
      unit_amount: 100000,
      currency: 'mxn',
      active: true,
      recurring: { interval: 'month', interval_count: 1 },
      product: 'prod_basic',
    });

    const result = await service.reconcileStripeSalePrice('studio-1', 'plan-basic', 'admin-1');

    expect(result.status).toBe('already_synced');
    expect(stripe.createRecurringPrice).not.toHaveBeenCalled();
    expect(prisma.membershipPlan.update).not.toHaveBeenCalled();
    expect(stripe.deactivatePrice).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('reconciles mismatch 1300 linked / 1000 desired and deactivates old Price', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(basePlan);
    stripe.retrievePrice.mockResolvedValue({
      id: 'price_old_1300',
      unit_amount: 130000,
      currency: 'mxn',
      active: true,
      recurring: { interval: 'month', interval_count: 1 },
      product: 'prod_basic',
    });
    stripe.createRecurringPrice.mockResolvedValue({ id: 'price_new_1000' });
    prisma.membershipPlan.update.mockResolvedValue({
      ...basePlan,
      stripePriceId: 'price_new_1000',
      classTemplateAccess: [],
    });

    const result = await service.reconcileStripeSalePrice('studio-1', 'plan-basic', 'admin-1');

    expect(result.status).toBe('reconciled');
    if (result.status === 'reconciled') {
      expect(result.newStripePriceId).toBe('price_new_1000');
      expect(result.previousStripePriceId).toBe('price_old_1300');
    }
    expect(stripe.createRecurringPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        unitAmount: 100000,
        currency: 'mxn',
        interval: 'month',
        metadata: expect.objectContaining({ source: 'catalog_reconciliation' }),
      }),
      expect.objectContaining({
        idempotencyKey: 'plan-price:plan-basic:100000:mxn:month:1',
      }),
    );
    expect(prisma.membershipPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stripePriceId: 'price_new_1000' }),
      }),
    );
    expect(stripe.deactivatePrice).toHaveBeenCalledWith('price_old_1300');
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MEMBERSHIP_PLAN_STRIPE_PRICE_RECONCILED',
        metadata: expect.objectContaining({
          source: 'catalog_reconciliation',
          previousStripePriceId: 'price_old_1300',
          newStripePriceId: 'price_new_1000',
          intendedPriceCents: 100000,
          result: 'reconciled',
        }),
      }),
    );
  });

  it('keeps plan pointer unchanged when Stripe create fails', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(basePlan);
    stripe.retrievePrice.mockResolvedValue({
      id: 'price_old_1300',
      unit_amount: 130000,
      currency: 'mxn',
      active: true,
      recurring: { interval: 'month', interval_count: 1 },
      product: 'prod_basic',
    });
    stripe.createRecurringPrice.mockRejectedValue(new Error('stripe down'));

    await expect(
      service.reconcileStripeSalePrice('studio-1', 'plan-basic', 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.membershipPlan.update).not.toHaveBeenCalled();
  });

  it('retries with same idempotency key after DB failure', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(basePlan);
    stripe.retrievePrice.mockResolvedValue({
      id: 'price_old_1300',
      unit_amount: 130000,
      currency: 'mxn',
      active: true,
      recurring: { interval: 'month', interval_count: 1 },
      product: 'prod_basic',
    });
    stripe.createRecurringPrice.mockResolvedValue({ id: 'price_new_1000' });
    prisma.membershipPlan.update
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({
        ...basePlan,
        stripePriceId: 'price_new_1000',
        classTemplateAccess: [],
      });

    await expect(
      service.reconcileStripeSalePrice('studio-1', 'plan-basic', 'admin-1'),
    ).rejects.toThrow('db down');

    await service.reconcileStripeSalePrice('studio-1', 'plan-basic', 'admin-1');

    expect(stripe.createRecurringPrice).toHaveBeenCalledTimes(2);
    const keys = stripe.createRecurringPrice.mock.calls.map((c) => c[1]?.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe('plan-price:plan-basic:100000:mxn:month:1');
  });

  it('returns not_applicable for cash-only plans', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      ...basePlan,
      stripeProductId: null,
      stripePriceId: null,
      classTemplateAccess: [],
    });

    const result = await service.reconcileStripeSalePrice('studio-1', 'plan-basic', 'admin-1');

    expect(result.status).toBe('not_applicable');
    expect(stripe.createRecurringPrice).not.toHaveBeenCalled();
    expect(prisma.membershipPlan.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for missing/cross-studio plan', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(null);

    await expect(
      service.reconcileStripeSalePrice('studio-1', 'plan-other', 'admin-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps new Price when old Price deactivation fails', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue(basePlan);
    stripe.retrievePrice.mockResolvedValue({
      id: 'price_old_1300',
      unit_amount: 130000,
      currency: 'mxn',
      active: true,
      recurring: { interval: 'month', interval_count: 1 },
      product: 'prod_basic',
    });
    stripe.createRecurringPrice.mockResolvedValue({ id: 'price_new_1000' });
    stripe.deactivatePrice.mockRejectedValue(new Error('archive failed'));
    prisma.membershipPlan.update.mockResolvedValue({
      ...basePlan,
      stripePriceId: 'price_new_1000',
      classTemplateAccess: [],
    });

    const result = await service.reconcileStripeSalePrice('studio-1', 'plan-basic', 'admin-1');

    expect(result.status).toBe('reconciled');
    expect(prisma.membershipPlan.update).toHaveBeenCalled();
  });
});
