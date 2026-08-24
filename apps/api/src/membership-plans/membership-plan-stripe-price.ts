import type { BillingInterval, MembershipPlan } from '@prisma/client';
import type Stripe from 'stripe';
import { billingIntervalToStripeRecurring } from '../billing/stripe-plan-interval';

export type PlanStripeRecurring = {
  interval: Stripe.PriceCreateParams.Recurring.Interval;
  intervalCount?: number;
};

/** Stripe recurring config for a plan's current sale identity. */
export function planStripeRecurring(plan: {
  billingInterval: BillingInterval;
  entitlementDays: number | null;
}): PlanStripeRecurring {
  if (plan.entitlementDays != null) {
    return { interval: 'day', intervalCount: plan.entitlementDays };
  }
  return billingIntervalToStripeRecurring(plan.billingInterval);
}

export type PlanFinancialIdentity = {
  priceCents: number;
  currency: string;
  billingInterval: BillingInterval;
  entitlementDays: number | null;
};

export function planFinancialIdentityChanged(
  before: PlanFinancialIdentity,
  after: PlanFinancialIdentity,
): boolean {
  return (
    before.priceCents !== after.priceCents ||
    before.currency.toLowerCase() !== after.currency.toLowerCase() ||
    before.billingInterval !== after.billingInterval ||
    before.entitlementDays !== after.entitlementDays
  );
}

export function isStripeBackedPlan(plan: Pick<MembershipPlan, 'stripeProductId' | 'stripePriceId'>): boolean {
  return Boolean(plan.stripeProductId || plan.stripePriceId);
}

/** Deterministic Stripe Idempotency-Key for catalog Price rotation. */
export function planSalePriceIdempotencyKey(
  planId: string,
  identity: PlanFinancialIdentity,
): string {
  const recurring = planStripeRecurring(identity);
  const intervalCount = recurring.intervalCount ?? 1;
  return [
    'plan-price',
    planId,
    String(identity.priceCents),
    identity.currency.toLowerCase(),
    recurring.interval,
    String(intervalCount),
  ].join(':');
}

export type StripePriceMatchResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'amount' | 'currency' | 'interval' | 'inactive' | 'missing_recurring';
    };

/** Whether a Stripe Price matches the plan's current sale configuration. */
export function stripePriceMatchesPlan(
  price: {
    unit_amount: number | null;
    currency: string | null | undefined;
    active: boolean;
    recurring: { interval: string; interval_count?: number | null } | null;
  },
  plan: PlanFinancialIdentity,
): StripePriceMatchResult {
  if (!price.active) {
    return { ok: false, reason: 'inactive' };
  }
  if (price.unit_amount !== plan.priceCents) {
    return { ok: false, reason: 'amount' };
  }
  if ((price.currency ?? '').toLowerCase() !== plan.currency.toLowerCase()) {
    return { ok: false, reason: 'currency' };
  }
  const expected = planStripeRecurring(plan);
  const actualInterval = price.recurring?.interval ?? null;
  const actualCount = price.recurring?.interval_count ?? 1;
  if (!actualInterval) {
    return { ok: false, reason: 'missing_recurring' };
  }
  if (actualInterval !== expected.interval || actualCount !== (expected.intervalCount ?? 1)) {
    return { ok: false, reason: 'interval' };
  }
  return { ok: true };
}
