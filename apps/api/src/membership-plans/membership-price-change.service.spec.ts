import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  MembershipPriceChangeItemStatus,
  MembershipPriceChangeScope,
  MembershipPriceChangeStatus,
  SubscriptionSource,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import { StripeService } from '../stripe/stripe.service';
import { MembershipPlansService } from './membership-plans.service';
import {
  MembershipPriceChangeService,
  STRIPE_UNPRORATED_PRICE_UPDATE,
} from './membership-price-change.service';

describe('MembershipPriceChangeService', () => {
  const plan = {
    id: 'plan-full',
    studioId: 'studio-1',
    name: 'Full',
    priceCents: 150000,
    currency: 'mxn',
    billingInterval: 'MONTHLY',
    entitlementDays: null,
    stripeProductId: 'prod_1',
    stripePriceId: 'price_old',
    deletedAt: null,
  };
  const cash = {
    id: 'sub-cash',
    userId: 'user-cash',
    source: SubscriptionSource.CASH,
    status: SubscriptionStatus.ACTIVE,
    priceCents: 150000,
    stripeSubscriptionId: null,
    user: { id: 'user-cash', firstName: 'Ana', lastName: 'Cash', email: 'ana@test.com', deletedAt: null },
    payments: [{ amountCents: 150000 }],
  };
  const stripeSub = {
    id: 'sub-stripe',
    userId: 'user-stripe',
    source: SubscriptionSource.STRIPE,
    status: SubscriptionStatus.ACTIVE,
    priceCents: 150000,
    stripeSubscriptionId: 'sub_stripe',
    user: { id: 'user-stripe', firstName: 'Luis', lastName: 'Stripe', email: 'luis@test.com', deletedAt: null },
    payments: [],
  };

  let service: MembershipPriceChangeService;
  let prisma: {
    membershipPlan: { findFirst: jest.Mock; update: jest.Mock };
    subscription: { findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
    membershipPriceChange: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    membershipPriceChangeItem: { updateMany: jest.Mock; update: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let stripe: { retrieveSubscription: jest.Mock; retrievePrice: jest.Mock; updateSubscription: jest.Mock; deactivatePrice: jest.Mock };
  let plans: { rotateStripeSalePrice: jest.Mock };

  beforeEach(async () => {
    prisma = {
      membershipPlan: {
        findFirst: jest.fn().mockResolvedValue(plan),
        update: jest.fn().mockResolvedValue({ ...plan, priceCents: 195000, stripePriceId: 'price_new' }),
      },
      subscription: {
        findMany: jest.fn().mockResolvedValue([cash, stripeSub]),
        findFirst: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
          where.id === 'sub-stripe' ? stripeSub : cash,
        ),
        update: jest.fn().mockResolvedValue({}),
      },
      membershipPriceChange: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      membershipPriceChangeItem: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn(),
      },
      $transaction: jest.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    };
    stripe = {
      retrieveSubscription: jest.fn().mockResolvedValue({
        items: { data: [{ id: 'si_1', price: { id: 'price_old', unit_amount: 150000 } }] },
      }),
      retrievePrice: jest.fn(),
      updateSubscription: jest.fn().mockResolvedValue({ id: 'sub_stripe' }),
      deactivatePrice: jest.fn().mockResolvedValue({}),
    };
    plans = {
      rotateStripeSalePrice: jest.fn().mockResolvedValue({
        previousStripePriceId: 'price_old',
        newStripePriceId: 'price_new',
        stripeProductId: 'prod_1',
      }),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MembershipPriceChangeService,
        { provide: PrismaService, useValue: prisma },
        { provide: StripeService, useValue: stripe },
        { provide: MembershipPlansService, useValue: plans },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(MembershipPriceChangeService);
  });

  function createdChange(scope: MembershipPriceChangeScope) {
    const applies = (subscriptionId: string) =>
      scope === MembershipPriceChangeScope.ALL_EXISTING ||
      (scope === MembershipPriceChangeScope.SELECTED && subscriptionId === 'sub-stripe');
    const items = [
      {
        id: 'item-cash',
        subscriptionId: 'sub-cash',
        userId: 'user-cash',
        source: SubscriptionSource.CASH,
        applyNewPrice: applies('sub-cash'),
        oldPriceCents: 150000,
        newPriceCents: applies('sub-cash') ? 195000 : 150000,
        status: MembershipPriceChangeItemStatus.PENDING,
        previousStripePriceId: null,
      },
      {
        id: 'item-stripe',
        subscriptionId: 'sub-stripe',
        userId: 'user-stripe',
        source: SubscriptionSource.STRIPE,
        applyNewPrice: applies('sub-stripe'),
        oldPriceCents: 150000,
        newPriceCents: applies('sub-stripe') ? 195000 : 150000,
        status: MembershipPriceChangeItemStatus.PENDING,
        previousStripePriceId: 'price_old',
      },
    ];
    const change = {
      id: 'change-1',
      studioId: 'studio-1',
      membershipPlanId: 'plan-full',
      scope,
      oldPriceCents: 150000,
      newPriceCents: 195000,
      currency: 'mxn',
      previousStripePriceId: 'price_old',
      newStripePriceId: 'price_new',
      status: MembershipPriceChangeStatus.APPLYING,
      idempotencyKey: 'idem-12345678',
      confirmedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
      items,
    };
    prisma.membershipPriceChange.create.mockImplementation(async () => change);
    prisma.membershipPriceChangeItem.findMany.mockResolvedValue(
      items.map((item) => ({ ...item, status: MembershipPriceChangeItemStatus.APPLIED })),
    );
    prisma.membershipPriceChange.update.mockImplementation(async ({ data }: { data: { status: string } }) => ({
      ...change,
      ...data,
      items: items.map((item) => ({ ...item, status: MembershipPriceChangeItemStatus.APPLIED })),
    }));
    return change;
  }

  it('previews only subscriptions of the edited plan', async () => {
    const preview = await service.preview('studio-1', 'plan-full', 195000);
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ membershipPlanId: 'plan-full' }),
    }));
    expect(preview.counts).toEqual({ total: 2, alreadyAtNewPrice: 0, wouldChange: 2 });
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('does not interpret a one-off historical cash payment as a legacy renewal price', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([
      { ...cash, priceCents: null, payments: [{ amountCents: 195000 }] },
      stripeSub,
    ]);
    const preview = await service.preview('studio-1', 'plan-full', 200000);
    const legacyCash = preview.members.find((m) => m.subscriptionId === 'sub-cash');
    expect(legacyCash?.currentPriceCents).toBe(150000);
    expect(legacyCash?.nextPriceCents).toBe(200000);
    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(plans.rotateStripeSalePrice).not.toHaveBeenCalled();
  });

  it('future-only rotates the catalog and does not update Stripe subscriptions', async () => {
    createdChange(MembershipPriceChangeScope.FUTURE_ONLY);
    const result = await service.apply('studio-1', 'plan-full', 'owner', {
      newPriceCents: 195000,
      scope: MembershipPriceChangeScope.FUTURE_ONLY,
      idempotencyKey: 'idem-12345678',
      confirm: true,
    });
    expect(plans.rotateStripeSalePrice).toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(result.status).toBe(MembershipPriceChangeStatus.COMPLETED);
  });

  it('updates a selected Stripe subscription without proration and leaves the other', async () => {
    createdChange(MembershipPriceChangeScope.SELECTED);
    await service.apply('studio-1', 'plan-full', 'owner', {
      newPriceCents: 195000,
      scope: MembershipPriceChangeScope.SELECTED,
      subscriptionIds: ['sub-stripe'],
      idempotencyKey: 'idem-12345678',
      confirm: true,
    });
    expect(stripe.updateSubscription).toHaveBeenCalledWith(
      'sub_stripe',
      { items: [{ id: 'si_1', price: 'price_new' }], ...STRIPE_UNPRORATED_PRICE_UPDATE },
      { idempotencyKey: 'membership-price-change:item-stripe' },
    );
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
    const cashWrite = prisma.subscription.update.mock.calls.find((call: [{ where: { id: string } }]) => call[0].where.id === 'sub-cash');
    expect(cashWrite).toBeUndefined();
  });

  it('leaves unselected member prices untouched even if the saved price differs from the preview', async () => {
    createdChange(MembershipPriceChangeScope.FUTURE_ONLY);
    prisma.subscription.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => (
      where.id === 'sub-stripe'
        ? { ...stripeSub, priceCents: 123456 }
        : { ...cash, priceCents: 110000 }
    ));
    await service.apply('studio-1', 'plan-full', 'owner', {
      newPriceCents: 195000,
      scope: MembershipPriceChangeScope.FUTURE_ONLY,
      idempotencyKey: 'idem-12345678',
      confirm: true,
    });
    expect(prisma.subscription.update).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('records a Stripe failure without changing that subscription price', async () => {
    const change = createdChange(MembershipPriceChangeScope.ALL_EXISTING);
    stripe.updateSubscription.mockRejectedValue(new Error('stripe down'));
    prisma.membershipPriceChangeItem.findMany.mockImplementation(async () =>
      change.items.map((item) => ({
        ...item,
        status: item.id === 'item-stripe'
          ? MembershipPriceChangeItemStatus.FAILED
          : MembershipPriceChangeItemStatus.APPLIED,
      })),
    );
    prisma.membershipPriceChange.update.mockImplementation(async ({ data }: { data: { status: string } }) => ({
      ...change,
      ...data,
      items: change.items.map((item) => ({
        ...item,
        status: item.id === 'item-stripe' ? MembershipPriceChangeItemStatus.FAILED : MembershipPriceChangeItemStatus.APPLIED,
        error: item.id === 'item-stripe' ? 'stripe down' : null,
      })),
    }));
    const result = await service.apply('studio-1', 'plan-full', 'owner', {
      newPriceCents: 195000,
      scope: MembershipPriceChangeScope.ALL_EXISTING,
      idempotencyKey: 'idem-12345678',
      confirm: true,
    });
    expect(result.status).toBe(MembershipPriceChangeStatus.PARTIAL);
    const stripePriceWrite = prisma.subscription.update.mock.calls.find((call: [{ where: { id: string } }]) => call[0].where.id === 'sub-stripe');
    expect(stripePriceWrite).toBeUndefined();
  });

  it('rejects replaying a personalized price-change key with different member selection', async () => {
    const recorded = createdChange(MembershipPriceChangeScope.SELECTED);
    prisma.membershipPriceChange.findUnique.mockResolvedValueOnce(recorded);
    await expect(service.apply('studio-1', 'plan-full', 'owner', {
      newPriceCents: 195000,
      scope: MembershipPriceChangeScope.SELECTED,
      subscriptionIds: ['sub-cash'],
      idempotencyKey: 'idem-12345678',
      confirm: true,
    })).rejects.toThrow('selección diferente');
    expect(plans.rotateStripeSalePrice).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  it('replays the same personalized price-change key and exact selection safely', async () => {
    const recorded = createdChange(MembershipPriceChangeScope.SELECTED);
    recorded.status = MembershipPriceChangeStatus.COMPLETED;
    prisma.membershipPriceChange.findUnique.mockResolvedValueOnce(recorded);
    const result = await service.apply('studio-1', 'plan-full', 'owner', {
      newPriceCents: 195000,
      scope: MembershipPriceChangeScope.SELECTED,
      subscriptionIds: ['sub-stripe', 'sub-stripe'],
      idempotencyKey: 'idem-12345678',
      confirm: true,
    });
    expect(result.status).toBe(MembershipPriceChangeStatus.COMPLETED);
    expect(plans.rotateStripeSalePrice).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  it('refuses a member selection with a non-personalized scope', async () => {
    await expect(service.apply('studio-1', 'plan-full', 'owner', {
      newPriceCents: 195000,
      scope: MembershipPriceChangeScope.FUTURE_ONLY,
      subscriptionIds: ['sub-cash'],
      idempotencyKey: 'idem-12345678',
      confirm: true,
    })).rejects.toThrow('opción personalizada');
    expect(plans.rotateStripeSalePrice).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('refuses an unconfirmed change', async () => {
    await expect(
      service.apply('studio-1', 'plan-full', 'owner', {
        newPriceCents: 195000,
        scope: MembershipPriceChangeScope.ALL_EXISTING,
        idempotencyKey: 'idem-12345678',
        confirm: false as unknown as true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(plans.rotateStripeSalePrice).not.toHaveBeenCalled();
  });
});
