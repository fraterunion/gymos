/**
 * Tests for the GET :userId/plan-change-preview endpoint behaviour.
 * These exercise SubscriptionLifecycleService.getPlanChangePreview directly
 * (the controller is thin — it validates planId and delegates).
 */

import { BadRequestException } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { SubscriptionLifecycleService } from '../billing/subscription-lifecycle.service';

function makeService(overrides: {
  plan?: Record<string, unknown> | null;
  currentSub?: Record<string, unknown> | null;
  stripeSub?: Record<string, unknown> | null;
}) {
  const basePlan = {
    id: 'plan-full',
    name: 'Full Access',
    priceCents: 200000,
    currency: 'mxn',
    billingInterval: 'MONTHLY',
    stripePriceId: 'price_full',
    active: true,
    deletedAt: null,
  };

  const prisma = {
    membershipPlan: {
      findFirst: jest.fn().mockImplementation(async (args: { where: { id?: string; active?: boolean } }) => {
        if (args.where.id === 'plan-full') return overrides.plan !== undefined ? overrides.plan : basePlan;
        return null;
      }),
    },
    subscription: {
      findFirst: jest.fn().mockImplementation(async (args: { where: { stripeSubscriptionId?: { not: null } } }) => {
        if (args.where.stripeSubscriptionId) return overrides.stripeSub !== undefined ? overrides.stripeSub : null;
        return overrides.currentSub !== undefined ? overrides.currentSub : null;
      }),
    },
  };

  const stripe = {};
  return new SubscriptionLifecycleService(prisma as never, stripe as never);
}

const STUDIO_ID = 'studio-1';
const MEMBER_ID = 'user-1';

// ── Test 1: Stripe Basic → Full (upgrade) ────────────────────────────────────

describe('plan-change-preview: Stripe Basic → Full upgrade', () => {
  it('returns effective=immediate and isPlanChange=true', async () => {
    const service = makeService({
      currentSub: {
        id: 'sub-1',
        membershipPlanId: 'plan-basic',
        pendingMembershipPlanId: null,
        stripeSubscriptionId: 'sub_stripe_1',
        status: SubscriptionStatus.ACTIVE,
        membershipPlan: { id: 'plan-basic', name: 'Basic Access', priceCents: 100000, currency: 'mxn', billingInterval: 'MONTHLY' },
      },
      stripeSub: {
        id: 'sub-1',
        membershipPlanId: 'plan-basic',
        pendingMembershipPlanId: null,
        stripeSubscriptionId: 'sub_stripe_1',
        status: SubscriptionStatus.ACTIVE,
        membershipPlan: { id: 'plan-basic', name: 'Basic Access', priceCents: 100000, currency: 'mxn', billingInterval: 'MONTHLY' },
      },
    });

    const result = await service.getPlanChangePreview({
      studioId: STUDIO_ID,
      userId: MEMBER_ID,
      targetPlanId: 'plan-full',
    });

    expect(result.isPlanChange).toBe(true);
    expect(result.hasCurrentMembership).toBe(true);
    expect(result.effective).toBe('immediate');
    expect(result.currentPlan?.id).toBe('plan-basic');
    expect(result.newPlan.id).toBe('plan-full');
  });
});

// ── Test 2: Full → Basic (downgrade) — scheduled ─────────────────────────────

describe('plan-change-preview: Full → Basic downgrade', () => {
  it('returns effective=next_period when Stripe sub exists', async () => {
    const fullPlan = { id: 'plan-full', name: 'Full Access', priceCents: 200000, currency: 'mxn', billingInterval: 'MONTHLY', stripePriceId: 'price_full', active: true, deletedAt: null };
    const basicPlan = { id: 'plan-basic', name: 'Basic Access', priceCents: 100000, currency: 'mxn', billingInterval: 'MONTHLY', stripePriceId: 'price_basic', active: true, deletedAt: null };

    const prisma = {
      membershipPlan: {
        findFirst: jest.fn().mockImplementation(async (args: { where: { id?: string } }) => {
          if (args.where.id === 'plan-basic') return basicPlan;
          if (args.where.id === 'plan-full') return fullPlan;
          return null;
        }),
      },
      subscription: {
        findFirst: jest.fn().mockImplementation(async (args: { where: { stripeSubscriptionId?: { not: null } } }) => ({
          id: 'sub-1',
          membershipPlanId: 'plan-full',
          pendingMembershipPlanId: null,
          stripeSubscriptionId: 'sub_stripe_1',
          status: SubscriptionStatus.ACTIVE,
          membershipPlan: fullPlan,
        })),
      },
    };

    const service = new SubscriptionLifecycleService(prisma as never, {} as never);

    const result = await service.getPlanChangePreview({
      studioId: STUDIO_ID,
      userId: MEMBER_ID,
      targetPlanId: 'plan-basic',
    });

    expect(result.effective).toBe('next_period');
    expect(result.currentPlan?.id).toBe('plan-full');
    expect(result.newPlan.id).toBe('plan-basic');
  });
});

// ── Test 3: Current plan cannot be selected ───────────────────────────────────

describe('plan-change-preview: same plan raises BadRequestException', () => {
  it('throws BadRequestException when targetPlanId === currentPlanId', async () => {
    const plan = { id: 'plan-basic', name: 'Basic Access', priceCents: 100000, currency: 'mxn', billingInterval: 'MONTHLY', stripePriceId: 'price_basic', active: true, deletedAt: null };

    const prisma = {
      membershipPlan: { findFirst: jest.fn().mockResolvedValue(plan) },
      subscription: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'sub-1',
          membershipPlanId: 'plan-basic',
          pendingMembershipPlanId: null,
          stripeSubscriptionId: 'sub_stripe_1',
          status: SubscriptionStatus.ACTIVE,
          membershipPlan: plan,
        }),
      },
    };

    const service = new SubscriptionLifecycleService(prisma as never, {} as never);

    await expect(
      service.getPlanChangePreview({ studioId: STUDIO_ID, userId: MEMBER_ID, targetPlanId: 'plan-basic' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ── Test 4: No Stripe sub → checkout path ────────────────────────────────────

describe('plan-change-preview: no Stripe subscription → checkout effective', () => {
  it('returns effective=checkout when member has cash-only subscription', async () => {
    const basicPlan = { id: 'plan-basic', name: 'Basic Access', priceCents: 100000, currency: 'mxn', billingInterval: 'MONTHLY', stripePriceId: null, active: true, deletedAt: null };
    const fullPlan = { id: 'plan-full', name: 'Full Access', priceCents: 200000, currency: 'mxn', billingInterval: 'MONTHLY', stripePriceId: 'price_full', active: true, deletedAt: null };

    const prisma = {
      membershipPlan: {
        findFirst: jest.fn().mockImplementation(async (args: { where: { id?: string } }) =>
          args.where.id === 'plan-full' ? fullPlan : basicPlan,
        ),
      },
      subscription: {
        findFirst: jest.fn().mockImplementation(async (args: { where: { stripeSubscriptionId?: { not: null } } }) => {
          if (args.where.stripeSubscriptionId) return null;  // no Stripe sub
          return {
            id: 'sub-cash',
            membershipPlanId: 'plan-basic',
            pendingMembershipPlanId: null,
            stripeSubscriptionId: null,
            status: SubscriptionStatus.ACTIVE,
            membershipPlan: basicPlan,
          };
        }),
      },
    };

    const service = new SubscriptionLifecycleService(prisma as never, {} as never);
    const result = await service.getPlanChangePreview({ studioId: STUDIO_ID, userId: MEMBER_ID, targetPlanId: 'plan-full' });

    expect(result.effective).toBe('checkout');
    expect(result.hasCurrentMembership).toBe(true);
  });
});

// ── Test 5: cancelAtPeriodEnd + upgrade → still immediate ────────────────────

describe('plan-change-preview: cancelAtPeriodEnd member upgrading', () => {
  it('returns effective=immediate — lifecycle decides, not UI', async () => {
    const basicPlan = { id: 'plan-basic', name: 'Basic', priceCents: 100000, currency: 'mxn', billingInterval: 'MONTHLY', stripePriceId: 'price_basic', active: true, deletedAt: null };
    const fullPlan = { id: 'plan-full', name: 'Full', priceCents: 200000, currency: 'mxn', billingInterval: 'MONTHLY', stripePriceId: 'price_full', active: true, deletedAt: null };

    const prisma = {
      membershipPlan: {
        findFirst: jest.fn().mockImplementation(async (args: { where: { id?: string } }) =>
          args.where.id === 'plan-full' ? fullPlan : basicPlan,
        ),
      },
      subscription: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'sub-1',
          membershipPlanId: 'plan-basic',
          pendingMembershipPlanId: null,
          stripeSubscriptionId: 'sub_stripe_cancel',
          cancelAtPeriodEnd: true,
          status: SubscriptionStatus.ACTIVE,
          membershipPlan: basicPlan,
        }),
      },
    };

    const service = new SubscriptionLifecycleService(prisma as never, {} as never);
    const result = await service.getPlanChangePreview({ studioId: STUDIO_ID, userId: MEMBER_ID, targetPlanId: 'plan-full' });

    expect(result.effective).toBe('immediate');
    expect(result.isPlanChange).toBe(true);
  });
});

// ── Test 6: no current membership → checkout ─────────────────────────────────

describe('plan-change-preview: no existing membership', () => {
  it('returns hasCurrentMembership=false and effective=checkout', async () => {
    const fullPlan = { id: 'plan-full', name: 'Full Access', priceCents: 200000, currency: 'mxn', billingInterval: 'MONTHLY', stripePriceId: 'price_full', active: true, deletedAt: null };

    const prisma = {
      membershipPlan: { findFirst: jest.fn().mockResolvedValue(fullPlan) },
      subscription: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    const service = new SubscriptionLifecycleService(prisma as never, {} as never);
    const result = await service.getPlanChangePreview({ studioId: STUDIO_ID, userId: MEMBER_ID, targetPlanId: 'plan-full' });

    expect(result.hasCurrentMembership).toBe(false);
    expect(result.effective).toBe('checkout');
    expect(result.isPlanChange).toBe(false);
  });
});
