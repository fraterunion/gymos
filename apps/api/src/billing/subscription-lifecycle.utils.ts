import type { MembershipPlan, Subscription } from '@prisma/client';

export type PlanSummary = {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  billingInterval: MembershipPlan['billingInterval'];
};

export function toPlanSummary(plan: MembershipPlan): PlanSummary {
  return {
    id: plan.id,
    name: plan.name,
    priceCents: plan.priceCents,
    currency: plan.currency,
    billingInterval: plan.billingInterval,
  };
}

export function isUpgrade(currentPriceCents: number, nextPriceCents: number): boolean {
  return nextPriceCents > currentPriceCents;
}

export function subscriptionLockKey(studioId: string, userId: string): string {
  return `${studioId}:${userId}`;
}

export function hasStripeRenewal(sub: Pick<Subscription, 'stripeSubscriptionId' | 'source'>): boolean {
  return sub.stripeSubscriptionId != null;
}
