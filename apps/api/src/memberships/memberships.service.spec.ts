import {
  MembershipsService,
  isSubscriptionExpiringWithin7Days,
  isSubscriptionRequiringAttention,
  subscriptionMatchesSearch,
  sortSubscriptionRows,
  effectiveEndSortKey,
} from './memberships.service';

function mockPrisma(subscriptionRows: unknown[]) {
  return {
    subscription: { findMany: jest.fn().mockResolvedValue(subscriptionRows) },
    auditLog: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('MembershipsService operations projection', () => {
  it('projects source, usage configuration and paid trial as operationally active', async () => {
    const now = Date.now();
    const row = {
      id: 'sub-1', studioId: 'studio-1', userId: 'user-1', membershipPlanId: 'plan-1',
      status: 'TRIALING', source: 'STRIPE', stripeSubscriptionId: 'sub_stripe',
      currentPeriodStart: new Date(now - 1_000), currentPeriodEnd: new Date(now + 86_400_000),
      entitlementEndsAt: new Date(now + 86_400_000), cancelAtPeriodEnd: false,
      createdAt: new Date(now - 1_000), updatedAt: new Date(now - 1_000),
      user: { id: 'user-1', email: 'member@example.com', firstName: 'Maky', lastName: 'D' },
      membershipPlan: { id: 'plan-1', name: 'Booty', billingInterval: 'MONTHLY', priceCents: 80000, currency: 'mxn', classCredits: 4, entitlementDays: 45 },
      entitlementCycles: [{ startsAt: new Date(now - 1_000), endsAt: new Date(now + 86_400_000) }],
    };
    const prisma = mockPrisma([row]);
    const service = new MembershipsService(prisma as never, {} as never);

    const result = await service.listSubscriptions('studio-1');

    expect(result.data[0]).toMatchObject({
      source: 'STRIPE',
      primaryStatus: 'ACTIVE',
      isEntitled: true,
      membershipPlan: { classCredits: 4, entitlementDays: 45 },
    });
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ entitlementCycles: expect.any(Object) }),
    }));
  });

  it('keeps a genuine unpaid provider trial distinct', async () => {
    const now = Date.now();
    const row = {
      id: 'sub-2', studioId: 'studio-1', userId: 'user-2', membershipPlanId: 'plan-2',
      status: 'TRIALING', source: 'STRIPE', stripeSubscriptionId: 'sub_trial',
      currentPeriodStart: new Date(now - 1_000), currentPeriodEnd: new Date(now + 86_400_000),
      entitlementEndsAt: null, cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(),
      user: { id: 'user-2', email: 'trial@example.com', firstName: 'Trial', lastName: 'Member' },
      membershipPlan: { id: 'plan-2', name: 'Trial', billingInterval: 'MONTHLY', priceCents: 0, currency: 'mxn', classCredits: 2, entitlementDays: null },
      entitlementCycles: [],
    };
    const prisma = mockPrisma([row]);
    const service = new MembershipsService(prisma as never, {} as never);

    const result = await service.listSubscriptions('studio-1');

    expect(result.data[0].primaryStatus).toBe('TRIALING');
  });

  it('filters attention subscriptions to PAST_DUE, PAUSED and EXPIRED', async () => {
    const now = Date.now();
    const rows = [
      { id: 'sub-past-due', status: 'PAST_DUE', source: 'STRIPE', stripeSubscriptionId: 's1', currentPeriodStart: new Date(now), currentPeriodEnd: new Date(now + 86_400_000), entitlementEndsAt: null, cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u1', email: 'a@x.com', firstName: 'A', lastName: 'B' }, membershipPlan: { id: 'p1', name: 'Basic', billingInterval: 'MONTHLY', priceCents: 1000, currency: 'mxn', classCredits: 12, entitlementDays: null }, entitlementCycles: [] },
      { id: 'sub-active', status: 'ACTIVE', source: 'CASH', stripeSubscriptionId: null, currentPeriodStart: new Date(now), currentPeriodEnd: new Date(now + 86_400_000), entitlementEndsAt: new Date(now + 86_400_000), cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u2', email: 'b@x.com', firstName: 'B', lastName: 'C' }, membershipPlan: { id: 'p1', name: 'Basic', billingInterval: 'MONTHLY', priceCents: 1000, currency: 'mxn', classCredits: 12, entitlementDays: null }, entitlementCycles: [{ startsAt: new Date(now), endsAt: new Date(now + 86_400_000) }] },
    ];
    const prisma = mockPrisma(rows);
    const service = new MembershipsService(prisma as never, {} as never);

    const result = await service.listSubscriptions('studio-1', { attention: true });

    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('sub-past-due');
  });

  it('filters expiring-within-7-days using entitled effective end boundary', async () => {
    const now = new Date('2026-08-20T12:00:00.000Z');
    jest.useFakeTimers({ now });
    const rows = [
      { id: 'sub-expiring', status: 'ACTIVE', source: 'CASH', stripeSubscriptionId: null, currentPeriodStart: new Date(now.getTime() - 86_400_000), currentPeriodEnd: new Date(now.getTime() + 3 * 86_400_000), entitlementEndsAt: new Date(now.getTime() + 3 * 86_400_000), cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u1', email: 'a@x.com', firstName: 'A', lastName: 'B' }, membershipPlan: { id: 'p1', name: 'Basic', billingInterval: 'MONTHLY', priceCents: 1000, currency: 'mxn', classCredits: 12, entitlementDays: null }, entitlementCycles: [{ startsAt: new Date(now.getTime() - 86_400_000), endsAt: new Date(now.getTime() + 3 * 86_400_000) }] },
      { id: 'sub-expired', status: 'ACTIVE', source: 'CASH', stripeSubscriptionId: null, currentPeriodStart: new Date(now.getTime() - 10 * 86_400_000), currentPeriodEnd: new Date(now.getTime() - 86_400_000), entitlementEndsAt: new Date(now.getTime() - 86_400_000), cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u2', email: 'b@x.com', firstName: 'B', lastName: 'C' }, membershipPlan: { id: 'p1', name: 'Basic', billingInterval: 'MONTHLY', priceCents: 1000, currency: 'mxn', classCredits: 12, entitlementDays: null }, entitlementCycles: [] },
      { id: 'sub-later', status: 'ACTIVE', source: 'CASH', stripeSubscriptionId: null, currentPeriodStart: new Date(now.getTime() - 86_400_000), currentPeriodEnd: new Date(now.getTime() + 20 * 86_400_000), entitlementEndsAt: new Date(now.getTime() + 20 * 86_400_000), cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u3', email: 'c@x.com', firstName: 'C', lastName: 'D' }, membershipPlan: { id: 'p1', name: 'Basic', billingInterval: 'MONTHLY', priceCents: 1000, currency: 'mxn', classCredits: 12, entitlementDays: null }, entitlementCycles: [{ startsAt: new Date(now.getTime() - 86_400_000), endsAt: new Date(now.getTime() + 20 * 86_400_000) }] },
    ];
    const prisma = mockPrisma(rows);
    const service = new MembershipsService(prisma as never, {} as never);

    const result = await service.listSubscriptions('studio-1', { expiringWithin7Days: true });

    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('sub-expiring');
    jest.useRealTimers();
  });

  it('counts subscriptions expiring within 7 days in overview', async () => {
    const now = Date.now();
    const prisma = {
      subscription: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 'user-1',
            status: 'ACTIVE',
            currentPeriodStart: new Date(now - 1_000),
            currentPeriodEnd: new Date(now + 3 * 86_400_000),
            entitlementEndsAt: null,
            cancelAtPeriodEnd: false,
          },
          {
            userId: 'user-2',
            status: 'ACTIVE',
            currentPeriodStart: new Date(now - 1_000),
            currentPeriodEnd: new Date(now + 20 * 86_400_000),
            entitlementEndsAt: null,
            cancelAtPeriodEnd: false,
          },
        ]),
      },
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const plansService = {
      listAllPlans: jest.fn().mockResolvedValue([
        { active: true, deletedAt: null, activeSubscriberCount: 2, mrrCents: 0 },
      ]),
    };
    const service = new MembershipsService(prisma as never, plansService as never);

    const overview = await service.getOverview('studio-1');

    expect(overview.expiringWithin7Days).toBe(1);
  });

  it('filters subscriptions by member name or email search', async () => {
    const now = Date.now();
    const rows = [
      { id: 'sub-a', status: 'ACTIVE', source: 'CASH', stripeSubscriptionId: null, currentPeriodStart: new Date(now), currentPeriodEnd: new Date(now + 86_400_000), entitlementEndsAt: new Date(now + 86_400_000), cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u1', email: 'ana@example.com', firstName: 'Ana', lastName: 'Villar' }, membershipPlan: { id: 'p1', name: 'Basic', billingInterval: 'MONTHLY', priceCents: 1000, currency: 'mxn', classCredits: 12, entitlementDays: null }, entitlementCycles: [] },
      { id: 'sub-b', status: 'ACTIVE', source: 'STRIPE', stripeSubscriptionId: 's1', currentPeriodStart: new Date(now), currentPeriodEnd: new Date(now + 86_400_000), entitlementEndsAt: null, cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u2', email: 'other@example.com', firstName: 'Victor', lastName: 'Herrera' }, membershipPlan: { id: 'p2', name: 'Pro', billingInterval: 'MONTHLY', priceCents: 600, currency: 'mxn', classCredits: 5, entitlementDays: null }, entitlementCycles: [] },
    ];
    const prisma = mockPrisma(rows);
    const service = new MembershipsService(prisma as never, {} as never);

    const result = await service.listSubscriptions('studio-1', { search: 'ana@example.com' });

    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('sub-a');
  });

  it('composes search with attention and plan filters', async () => {
    const now = Date.now();
    const rows = [
      { id: 'sub-past-due-ana', status: 'PAST_DUE', source: 'STRIPE', stripeSubscriptionId: 's1', currentPeriodStart: new Date(now), currentPeriodEnd: new Date(now + 86_400_000), entitlementEndsAt: null, cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u1', email: 'ana@example.com', firstName: 'Ana', lastName: 'Villar' }, membershipPlan: { id: 'plan-basic', name: 'Basic', billingInterval: 'MONTHLY', priceCents: 1000, currency: 'mxn', classCredits: 12, entitlementDays: null }, entitlementCycles: [] },
      { id: 'sub-past-due-victor', status: 'PAST_DUE', source: 'STRIPE', stripeSubscriptionId: 's2', currentPeriodStart: new Date(now), currentPeriodEnd: new Date(now + 86_400_000), entitlementEndsAt: null, cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u2', email: 'victor@example.com', firstName: 'Victor', lastName: 'Herrera' }, membershipPlan: { id: 'plan-pro', name: 'Pro', billingInterval: 'MONTHLY', priceCents: 600, currency: 'mxn', classCredits: 5, entitlementDays: null }, entitlementCycles: [] },
    ];
    const prisma = mockPrisma(rows);
    const service = new MembershipsService(prisma as never, {} as never);

    const result = await service.listSubscriptions('studio-1', {
      attention: true,
      planId: 'plan-basic',
      search: 'ana',
    });

    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('sub-past-due-ana');
  });

  it('composes search with expiringWithin7Days filter', async () => {
    const now = new Date('2026-08-20T12:00:00.000Z');
    jest.useFakeTimers({ now });
    const rows = [
      { id: 'sub-expiring-ana', status: 'ACTIVE', source: 'CASH', stripeSubscriptionId: null, currentPeriodStart: new Date(now.getTime() - 86_400_000), currentPeriodEnd: new Date(now.getTime() + 2 * 86_400_000), entitlementEndsAt: new Date(now.getTime() + 2 * 86_400_000), cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u1', email: 'ana@example.com', firstName: 'Ana', lastName: 'Villar' }, membershipPlan: { id: 'p1', name: 'Basic', billingInterval: 'MONTHLY', priceCents: 1000, currency: 'mxn', classCredits: 12, entitlementDays: null }, entitlementCycles: [{ startsAt: new Date(now.getTime() - 86_400_000), endsAt: new Date(now.getTime() + 2 * 86_400_000) }] },
      { id: 'sub-expiring-victor', status: 'ACTIVE', source: 'STRIPE', stripeSubscriptionId: 's1', currentPeriodStart: new Date(now.getTime() - 86_400_000), currentPeriodEnd: new Date(now.getTime() + 3 * 86_400_000), entitlementEndsAt: new Date(now.getTime() + 3 * 86_400_000), cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u2', email: 'victor@example.com', firstName: 'Victor', lastName: 'Herrera' }, membershipPlan: { id: 'p2', name: 'Pro', billingInterval: 'MONTHLY', priceCents: 600, currency: 'mxn', classCredits: 5, entitlementDays: null }, entitlementCycles: [{ startsAt: new Date(now.getTime() - 86_400_000), endsAt: new Date(now.getTime() + 3 * 86_400_000) }] },
    ];
    const prisma = mockPrisma(rows);
    const service = new MembershipsService(prisma as never, {} as never);

    const result = await service.listSubscriptions('studio-1', {
      expiringWithin7Days: true,
      search: 'victor',
    });

    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('sub-expiring-victor');
    jest.useRealTimers();
  });

  it('sorts subscriptions by effective end ascending for upcoming renewals', async () => {
    const now = new Date('2026-08-20T12:00:00.000Z');
    jest.useFakeTimers({ now });
    const rows = [
      { id: 'sub-later', status: 'ACTIVE', source: 'CASH', stripeSubscriptionId: null, currentPeriodStart: new Date(now.getTime() - 86_400_000), currentPeriodEnd: new Date(now.getTime() + 10 * 86_400_000), entitlementEndsAt: new Date(now.getTime() + 10 * 86_400_000), cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u1', email: 'a@x.com', firstName: 'A', lastName: 'Later' }, membershipPlan: { id: 'p1', name: 'Basic', billingInterval: 'MONTHLY', priceCents: 1000, currency: 'mxn', classCredits: 12, entitlementDays: null }, entitlementCycles: [{ startsAt: new Date(now.getTime() - 86_400_000), endsAt: new Date(now.getTime() + 10 * 86_400_000) }] },
      { id: 'sub-soon', status: 'ACTIVE', source: 'CASH', stripeSubscriptionId: null, currentPeriodStart: new Date(now.getTime() - 86_400_000), currentPeriodEnd: new Date(now.getTime() + 2 * 86_400_000), entitlementEndsAt: new Date(now.getTime() + 2 * 86_400_000), cancelAtPeriodEnd: false, createdAt: new Date(), updatedAt: new Date(), user: { id: 'u2', email: 'b@x.com', firstName: 'B', lastName: 'Soon' }, membershipPlan: { id: 'p1', name: 'Basic', billingInterval: 'MONTHLY', priceCents: 1000, currency: 'mxn', classCredits: 12, entitlementDays: null }, entitlementCycles: [{ startsAt: new Date(now.getTime() - 86_400_000), endsAt: new Date(now.getTime() + 2 * 86_400_000) }] },
    ];
    const prisma = mockPrisma(rows);
    const service = new MembershipsService(prisma as never, {} as never);

    const result = await service.listSubscriptions('studio-1', { sort: 'effective_end_asc' });

    expect(result.data.map((row) => row.id)).toEqual(['sub-soon', 'sub-later']);
    jest.useRealTimers();
  });
});

describe('membership KPI filter helpers', () => {
  it('requires attention for PAST_DUE, PAUSED and EXPIRED only', () => {
    for (const status of ['PAST_DUE', 'PAUSED', 'EXPIRED'] as const) {
      expect(isSubscriptionRequiringAttention({ lifecycleStatus: status } as never)).toBe(true);
    }
    expect(isSubscriptionRequiringAttention({ lifecycleStatus: 'ACTIVE' } as never)).toBe(false);
  });

  it('expiring boundary excludes already expired and non-entitled rows', () => {
    const now = new Date('2026-08-20T12:00:00.000Z');
    const sevenDays = new Date(now.getTime() + 7 * 86_400_000);
    expect(
      isSubscriptionExpiringWithin7Days(
        { isEntitled: true, effectiveEnd: new Date(now.getTime() + 3 * 86_400_000) } as never,
        now,
        sevenDays,
      ),
    ).toBe(true);
    expect(
      isSubscriptionExpiringWithin7Days(
        { isEntitled: true, effectiveEnd: new Date(now.getTime() - 1_000) } as never,
        now,
        sevenDays,
      ),
    ).toBe(false);
    expect(
      isSubscriptionExpiringWithin7Days(
        { isEntitled: false, effectiveEnd: new Date(now.getTime() + 3 * 86_400_000) } as never,
        now,
        sevenDays,
      ),
    ).toBe(false);
  });

  it('matches search case-insensitively across name and email', () => {
    expect(
      subscriptionMatchesSearch(
        { firstName: 'Ana', lastName: 'Villar', email: 'ana@example.com' },
        'ANA@EXAMPLE',
      ),
    ).toBe(true);
    expect(
      subscriptionMatchesSearch(
        { firstName: 'Victor', lastName: 'Herrera', email: 'v@x.com' },
        'herrera',
      ),
    ).toBe(true);
  });

  it('sorts by effective end with nulls last', () => {
    const now = new Date('2026-08-20T12:00:00.000Z');
    const rows = sortSubscriptionRows(
      [
        { lifecycle: { effectiveEnd: new Date(now.getTime() + 5 * 86_400_000), isEntitled: true, lifecycleStatus: 'ACTIVE' } as never },
        { lifecycle: { effectiveEnd: null, isEntitled: true, lifecycleStatus: 'ACTIVE' } as never },
        { lifecycle: { effectiveEnd: new Date(now.getTime() + 1 * 86_400_000), isEntitled: true, lifecycleStatus: 'ACTIVE' } as never },
      ],
      'effective_end_asc',
    );
    expect(effectiveEndSortKey(rows[0].lifecycle)).toBeLessThan(
      effectiveEndSortKey(rows[1].lifecycle),
    );
    expect((rows[2].lifecycle as { effectiveEnd: Date | null }).effectiveEnd).toBeNull();
  });
});
