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
  CONCURRENT_PRICE_CHANGE_MESSAGE,
  MembershipPriceChangeService,
  STALE_MEMBER_PRICE_MESSAGE,
  STRIPE_UNPRORATED_PRICE_UPDATE,
  SUPERSEDED_PRICE_CHANGE_MESSAGE,
  stripeSwapBlockReason,
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
  const monthly = { currency: 'mxn', recurring: { interval: 'month', interval_count: 1 } };
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
    membershipPlan: { findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    subscription: { findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    membershipPriceChange: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
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
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      subscription: {
        findMany: jest.fn().mockResolvedValue([cash, stripeSub]),
        findFirst: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
          where.id === 'sub-stripe' ? stripeSub : cash,
        ),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      membershipPriceChange: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
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
        items: { data: [{ id: 'si_1', price: { id: 'price_old', unit_amount: 150000, ...monthly } }] },
      }),
      retrievePrice: jest.fn(async (id: string) => ({ id, unit_amount: id === 'price_new' ? 195000 : 150000, ...monthly })),
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
    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('never changes a Stripe member price locally when their Stripe subscription ID is missing', async () => {
    const change = createdChange(MembershipPriceChangeScope.ALL_EXISTING);
    prisma.subscription.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => (
      where.id === 'sub-stripe'
        ? { ...stripeSub, stripeSubscriptionId: null }
        : cash
    ));
    await service.apply('studio-1', 'plan-full', 'owner', {
      newPriceCents: 195000,
      scope: MembershipPriceChangeScope.ALL_EXISTING,
      idempotencyKey: 'idem-12345678',
      confirm: true,
    });
    const stripePriceWrite = prisma.subscription.update.mock.calls.find(
      (call: [{ where: { id: string } }]) => call[0].where.id === 'sub-stripe',
    );
    expect(stripePriceWrite).toBeUndefined();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(prisma.membershipPriceChangeItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-stripe' },
        data: expect.objectContaining({
          status: MembershipPriceChangeItemStatus.FAILED,
          error: expect.stringContaining('identificador'),
        }),
      }),
    );
    expect(change.items.find((item) => item.id === 'item-stripe')?.applyNewPrice).toBe(true);
  });

  it('never swaps a Stripe item whose live cadence differs from the new price (Stripe would invoice now)', async () => {
    createdChange(MembershipPriceChangeScope.SELECTED);
    stripe.retrieveSubscription.mockResolvedValue({
      items: { data: [{ id: 'si_1', price: { id: 'price_old', unit_amount: 150000, currency: 'mxn', recurring: { interval: 'day', interval_count: 45 } } }] },
    });
    await service.apply('studio-1', 'plan-full', 'owner', {
      newPriceCents: 195000,
      scope: MembershipPriceChangeScope.SELECTED,
      subscriptionIds: ['sub-stripe'],
      idempotencyKey: 'idem-12345678',
      confirm: true,
    });
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    const stripePriceWrite = prisma.subscription.update.mock.calls.find(
      (call: [{ where: { id: string } }]) => call[0].where.id === 'sub-stripe',
    );
    expect(stripePriceWrite).toBeUndefined();
    expect(prisma.membershipPriceChangeItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-stripe' },
        data: expect.objectContaining({
          status: MembershipPriceChangeItemStatus.FAILED,
          error: expect.stringContaining('ciclo de cobro'),
        }),
      }),
    );
  });

  it('pins an excluded member without any price lock to the price they had before the change', async () => {
    createdChange(MembershipPriceChangeScope.FUTURE_ONLY);
    prisma.subscription.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'sub-stripe' ? stripeSub : { ...cash, priceCents: null },
    );
    await service.apply('studio-1', 'plan-full', 'owner', {
      newPriceCents: 195000,
      scope: MembershipPriceChangeScope.FUTURE_ONLY,
      idempotencyKey: 'idem-12345678',
      confirm: true,
    });
    expect(prisma.subscription.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: 'sub-cash', priceCents: null },
      data: { priceCents: 150000 },
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

  it('resumes an APPLYING change with the same public response shape and no catalog rotation', async () => {
    const recorded = createdChange(MembershipPriceChangeScope.FUTURE_ONLY);
    prisma.membershipPriceChange.findUnique.mockResolvedValueOnce(recorded);
    const result = await service.apply('studio-1', 'plan-full', 'owner', {
      newPriceCents: 195000,
      scope: MembershipPriceChangeScope.FUTURE_ONLY,
      idempotencyKey: 'idem-12345678',
      confirm: true,
    });
    expect(result).toEqual(expect.objectContaining({
      id: 'change-1',
      status: MembershipPriceChangeStatus.COMPLETED,
      idempotentReplay: true,
      counts: expect.objectContaining({ applied: 2, failed: 0 }),
    }));
    expect(prisma.membershipPriceChange.update).toHaveBeenCalledTimes(1);
    expect(plans.rotateStripeSalePrice).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(prisma.membershipPlan.update).not.toHaveBeenCalled();
  });

  it('replays the same personalized price-change key and exact selection safely', async () => {
    const recorded = {
      ...createdChange(MembershipPriceChangeScope.SELECTED),
      status: MembershipPriceChangeStatus.COMPLETED,
    };
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

  describe('retry', () => {
    function partialChange() {
      const change = createdChange(MembershipPriceChangeScope.ALL_EXISTING);
      const stored = {
        ...change,
        status: MembershipPriceChangeStatus.PARTIAL,
        items: change.items.map((item) => ({
          ...item,
          status: item.id === 'item-stripe' ? MembershipPriceChangeItemStatus.FAILED : MembershipPriceChangeItemStatus.APPLIED,
        })),
      };
      prisma.membershipPriceChange.findFirst.mockResolvedValueOnce(stored); // load
      prisma.membershipPriceChange.findUniqueOrThrow.mockResolvedValue({
        ...stored,
        status: MembershipPriceChangeStatus.APPLYING,
        items: stored.items.map((item) => ({ ...item, status: item.id === 'item-stripe' ? MembershipPriceChangeItemStatus.PENDING : item.status })),
      });
      return stored;
    }

    it('re-applies only the failed member with the same Stripe idempotency key', async () => {
      partialChange();
      prisma.membershipPriceChange.findFirst.mockResolvedValueOnce(null); // no newer change
      await service.retry('studio-1', 'plan-full', 'change-1', 'owner', true);
      expect(prisma.membershipPriceChangeItem.updateMany).toHaveBeenCalledWith({
        where: { priceChangeId: 'change-1', status: MembershipPriceChangeItemStatus.FAILED },
        data: { status: MembershipPriceChangeItemStatus.PENDING, error: null },
      });
      expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
      expect(stripe.updateSubscription).toHaveBeenCalledWith(
        'sub_stripe',
        { items: [{ id: 'si_1', price: 'price_new' }], ...STRIPE_UNPRORATED_PRICE_UPDATE },
        { idempotencyKey: 'membership-price-change:item-stripe' },
      );
      // The already-applied CASH member is not touched again.
      const cashWrite = prisma.subscription.update.mock.calls.find((call: [{ where: { id: string } }]) => call[0].where.id === 'sub-cash');
      expect(cashWrite).toBeUndefined();
    });

    it('refuses to retry a change that a newer price change for the plan superseded', async () => {
      partialChange();
      prisma.membershipPriceChange.findFirst.mockResolvedValueOnce({ id: 'change-2' }); // newer change exists
      await expect(service.retry('studio-1', 'plan-full', 'change-1', 'owner', true)).rejects.toThrow(SUPERSEDED_PRICE_CHANGE_MESSAGE);
      expect(prisma.membershipPriceChangeItem.updateMany).not.toHaveBeenCalled();
      expect(prisma.membershipPriceChange.update).not.toHaveBeenCalled();
      expect(stripe.updateSubscription).not.toHaveBeenCalled();
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('returns a completed change without re-executing anything', async () => {
      const change = createdChange(MembershipPriceChangeScope.ALL_EXISTING);
      prisma.membershipPriceChange.findFirst.mockResolvedValueOnce({ ...change, status: MembershipPriceChangeStatus.COMPLETED });
      const result = await service.retry('studio-1', 'plan-full', 'change-1', 'owner', true);
      expect(result.idempotentReplay).toBe(true);
      expect(prisma.membershipPriceChangeItem.updateMany).not.toHaveBeenCalled();
      expect(stripe.updateSubscription).not.toHaveBeenCalled();
    });
  });

  describe('stale members', () => {
    it('never moves a Stripe member whose live price changed after the preview', async () => {
      createdChange(MembershipPriceChangeScope.SELECTED);
      stripe.retrieveSubscription.mockResolvedValue({
        items: { data: [{ id: 'si_1', price: { id: 'price_newer_decision', unit_amount: 170000, ...monthly } }] },
      });
      await service.apply('studio-1', 'plan-full', 'owner', {
        newPriceCents: 195000,
        scope: MembershipPriceChangeScope.SELECTED,
        subscriptionIds: ['sub-stripe'],
        idempotencyKey: 'idem-12345678',
        confirm: true,
      });
      expect(stripe.updateSubscription).not.toHaveBeenCalled();
      expect(prisma.membershipPriceChangeItem.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'item-stripe' },
        data: expect.objectContaining({ status: MembershipPriceChangeItemStatus.FAILED, error: STALE_MEMBER_PRICE_MESSAGE }),
      }));
    });

    it('never overwrites a CASH lock that changed after the preview', async () => {
      createdChange(MembershipPriceChangeScope.ALL_EXISTING);
      prisma.subscription.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === 'sub-stripe' ? stripeSub : { ...cash, priceCents: 170000 },
      );
      await service.apply('studio-1', 'plan-full', 'owner', {
        newPriceCents: 195000,
        scope: MembershipPriceChangeScope.ALL_EXISTING,
        idempotencyKey: 'idem-12345678',
        confirm: true,
      });
      const cashWrite = prisma.subscription.update.mock.calls.find((call: [{ where: { id: string } }]) => call[0].where.id === 'sub-cash');
      expect(cashWrite).toBeUndefined();
      expect(prisma.membershipPriceChangeItem.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'item-cash' },
        data: expect.objectContaining({ status: MembershipPriceChangeItemStatus.FAILED, error: STALE_MEMBER_PRICE_MESSAGE }),
      }));
    });
  });

  describe('concurrent administrator submissions', () => {
    const request = {
      newPriceCents: 195000,
      scope: MembershipPriceChangeScope.FUTURE_ONLY,
      idempotencyKey: 'idem-12345678',
      confirm: true as const,
    };

    it('refuses while another change for the plan is still applying', async () => {
      createdChange(MembershipPriceChangeScope.FUTURE_ONLY);
      prisma.membershipPriceChange.count.mockResolvedValue(1);
      await expect(service.apply('studio-1', 'plan-full', 'owner', request)).rejects.toThrow(CONCURRENT_PRICE_CHANGE_MESSAGE);
      expect(prisma.membershipPlan.updateMany).not.toHaveBeenCalled();
      expect(prisma.membershipPriceChange.create).not.toHaveBeenCalled();
      expect(stripe.updateSubscription).not.toHaveBeenCalled();
    });

    it('a different decision that lost the race gets 409 and its unused Stripe price is archived', async () => {
      createdChange(MembershipPriceChangeScope.FUTURE_ONLY);
      prisma.membershipPlan.updateMany.mockResolvedValue({ count: 0 }); // plan price moved under us
      prisma.membershipPlan.findFirst
        .mockResolvedValueOnce(plan) // requirePlan
        .mockResolvedValueOnce({ stripePriceId: 'price_winner' }); // after losing
      await expect(service.apply('studio-1', 'plan-full', 'owner', request)).rejects.toThrow(CONCURRENT_PRICE_CHANGE_MESSAGE);
      expect(prisma.membershipPriceChange.create).not.toHaveBeenCalled();
      expect(stripe.deactivatePrice).toHaveBeenCalledWith('price_new');
      expect(stripe.updateSubscription).not.toHaveBeenCalled();
    });

    it('a double submit that reads the plan after its twin committed replays instead of failing as a no-op', async () => {
      const change = createdChange(MembershipPriceChangeScope.FUTURE_ONLY);
      prisma.membershipPlan.findFirst.mockResolvedValueOnce({ ...plan, priceCents: 195000 }); // already the new price
      prisma.membershipPriceChange.findUnique
        .mockResolvedValueOnce(null) // first lookup: twin not committed yet
        .mockResolvedValueOnce(change); // re-check after reading the plan: twin committed
      const result = await service.apply('studio-1', 'plan-full', 'owner', request);
      expect(result.id).toBe('change-1');
      expect(result.idempotentReplay).toBe(true);
      expect(plans.rotateStripeSalePrice).not.toHaveBeenCalled();
      expect(prisma.membershipPriceChange.create).not.toHaveBeenCalled();
      expect(prisma.membershipPriceChangeItem.updateMany).not.toHaveBeenCalled();
    });

    it('a genuinely unchanged price is still rejected', async () => {
      prisma.membershipPlan.findFirst.mockResolvedValueOnce({ ...plan, priceCents: 195000 });
      await expect(service.apply('studio-1', 'plan-full', 'owner', request)).rejects.toThrow('igual al precio actual');
      expect(prisma.membershipPriceChange.create).not.toHaveBeenCalled();
    });

    it('a double submit of the same request returns the recorded change without executing it twice', async () => {
      const change = createdChange(MembershipPriceChangeScope.FUTURE_ONLY);
      prisma.membershipPlan.updateMany.mockResolvedValue({ count: 0 });
      prisma.membershipPlan.findFirst
        .mockResolvedValueOnce(plan)
        .mockResolvedValueOnce({ stripePriceId: 'price_new' }); // the winner uses the same Price
      prisma.membershipPriceChange.findUnique
        .mockResolvedValueOnce(null) // first lookup: nothing yet
        .mockResolvedValueOnce(change); // after losing: the winner's change, still APPLYING
      const result = await service.apply('studio-1', 'plan-full', 'owner', request);
      expect(result.id).toBe('change-1');
      expect(result.idempotentReplay).toBe(true);
      expect(stripe.deactivatePrice).not.toHaveBeenCalled();
      expect(prisma.membershipPriceChangeItem.updateMany).not.toHaveBeenCalled(); // not re-executed
    });
  });

  describe('stripeSwapBlockReason', () => {
    const shape = { unitAmount: 150000, currency: 'mxn', interval: 'month', intervalCount: 1 };
    const live = { ...shape, itemCount: 1 };
    it('allows a same-currency, same-cadence, non-zero swap', () => {
      expect(stripeSwapBlockReason(live, { ...shape, unitAmount: 195000 })).toBeNull();
    });
    it.each([
      ['several items', { ...live, itemCount: 2 }, shape, 'varios conceptos'],
      ['a free live price', { ...live, unitAmount: 0 }, shape, '$0'],
      ['a free target price', live, { ...shape, unitAmount: 0 }, '$0'],
      ['another currency', live, { ...shape, currency: 'usd' }, 'moneda'],
      ['another interval', live, { ...shape, interval: 'day', intervalCount: 45 }, 'ciclo de cobro'],
      ['another interval count', live, { ...shape, intervalCount: 3 }, 'ciclo de cobro'],
    ])('blocks %s', (_label, l, t, message) => {
      expect(stripeSwapBlockReason(l, t)).toContain(message);
    });
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
