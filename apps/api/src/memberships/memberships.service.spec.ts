import { MembershipsService } from './memberships.service';

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
    const prisma = {
      subscription: {
        findMany: jest.fn().mockResolvedValue([row]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
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
    const prisma = { subscription: { findMany: jest.fn().mockResolvedValue([row]), count: jest.fn().mockResolvedValue(1) } };
    const service = new MembershipsService(prisma as never, {} as never);

    const result = await service.listSubscriptions('studio-1');

    expect(result.data[0].primaryStatus).toBe('TRIALING');
  });
});
