import { BillingInterval, SubscriptionStatus } from '@prisma/client';
import type { SubscriptionStatus as SubStatus } from '@prisma/client';

/** Normalizes plan catalog price to monthly cents. */
export function monthlyEquivalentCents(priceCents: number, interval: BillingInterval): number {
  switch (interval) {
    case BillingInterval.MONTHLY:
      return priceCents;
    case BillingInterval.YEARLY:
      return Math.round(priceCents / 12);
    case BillingInterval.WEEKLY:
      return Math.round((priceCents * 52) / 12);
    default:
      return priceCents;
  }
}

export type MrrSubscriptionRow = {
  status: SubStatus;
  cancelAtPeriodEnd: boolean;
  membershipPlan: { priceCents: number; billingInterval: BillingInterval };
};

/**
 * Phase 1 MRR: catalog price of ACTIVE subscriptions only, normalized to monthly.
 * TRIALING, PAST_DUE, PAUSED, CANCELED excluded.
 * cancelAtPeriodEnd ACTIVE subs included (still contracted until period end).
 * Review/test accounts must be filtered before calling.
 */
export function computeEstimatedMrrCents(subscriptions: MrrSubscriptionRow[]): number {
  let total = 0;
  for (const s of subscriptions) {
    if (s.status !== SubscriptionStatus.ACTIVE) continue;
    total += monthlyEquivalentCents(
      s.membershipPlan.priceCents,
      s.membershipPlan.billingInterval,
    );
  }
  return total;
}

export type ExecutiveReconciliationInput = {
  monthCollectedCents: number;
  monthBreakdownTotalCents: number;
  monthTrendSumCents: number;
  monthTrendPaymentCount: number;
  monthPaymentCount: number;
  monthStripeCents: number;
  monthCashCents: number;
  monthOtherCents: number;
  monthPlanAttributedCents: number;
  monthUnattributedCents: number;
};

export type ExecutiveReconciliationResult = {
  methodSplitEqualsTotal: boolean;
  trendAmountEqualsTotal: boolean;
  trendCountEqualsTotal: boolean;
  breakdownEqualsMonthCollected: boolean;
  planAttributedPlusUnattributed: boolean;
};

export function buildExecutiveReconciliation(
  input: ExecutiveReconciliationInput,
): ExecutiveReconciliationResult {
  const methodTotal = input.monthStripeCents + input.monthCashCents + input.monthOtherCents;
  return {
    methodSplitEqualsTotal: methodTotal === input.monthCollectedCents,
    trendAmountEqualsTotal: input.monthTrendSumCents === input.monthCollectedCents,
    trendCountEqualsTotal: input.monthTrendPaymentCount === input.monthPaymentCount,
    breakdownEqualsMonthCollected:
      input.monthBreakdownTotalCents === input.monthCollectedCents,
    planAttributedPlusUnattributed:
      input.monthPlanAttributedCents + input.monthUnattributedCents ===
      input.monthCollectedCents,
  };
}

export type ExecutiveDataQualityInput = {
  lastPaymentAt: Date | null;
  subsMissingStripeId: number;
  activeStripeSubscriptionsWithoutPayment: number;
  syncMayBeIncomplete?: boolean;
};

export type ExecutiveDataQualityResult = {
  lastPaymentAt: string | null;
  warnings: string[];
};

export function buildExecutiveDataQuality(
  input: ExecutiveDataQualityInput,
): ExecutiveDataQualityResult {
  const warnings: string[] = [];

  if (input.syncMayBeIncomplete || input.activeStripeSubscriptionsWithoutPayment > 0) {
    warnings.push('La sincronización de pagos puede estar incompleta.');
  }

  if (input.activeStripeSubscriptionsWithoutPayment > 0) {
    warnings.push('Hay membresías de Stripe sin un pago registrado.');
  }

  if (input.subsMissingStripeId > 0) {
    warnings.push('Algunas membresías no están vinculadas con Stripe.');
  }

  return {
    lastPaymentAt: input.lastPaymentAt?.toISOString() ?? null,
    warnings,
  };
}

/** Maps stored payment method enum to owner-safe label (no card brand/last4). */
export function paymentMethodOwnerLabel(method: string | null | undefined): string | null {
  if (!method) return null;
  switch (method) {
    case 'STRIPE':
      return 'Stripe';
    case 'CASH':
      return 'Efectivo';
    case 'TERMINAL':
      return 'Terminal';
    default:
      return 'Otro';
  }
}

export const MRR_DEFINITION = {
  kind: 'estimated_catalog' as const,
  description:
    'Suma del precio de catálogo de suscripciones ACTIVE, normalizado a equivalente mensual. Excluye TRIALING, PAST_DUE, PAUSED y CANCELED.',
  includesStatuses: ['ACTIVE'] as const,
  includesCancelAtPeriodEnd: true,
  excludesStatuses: ['TRIALING', 'PAST_DUE', 'PAUSED', 'CANCELED'] as const,
  excludesReviewAccounts: true,
};

export const UPCOMING_REVENUE_DEFINITION = {
  kind: 'estimated_renewals' as const,
  description:
    'Precio de catálogo del plan en la fecha de renovación local. No son facturas de Stripe.',
  eligibleStatuses: ['ACTIVE'] as const,
  excludesCancelAtPeriodEnd: true,
  excludesTrialing: true,
  excludesPastDue: true,
  excludesPaused: true,
};

/** Returns true when subscription qualifies for upcoming renewal estimate list. */
export function isRenewalEligible(input: {
  status: SubscriptionStatus;
  cancelAtPeriodEnd: boolean;
}): boolean {
  return input.status === SubscriptionStatus.ACTIVE && !input.cancelAtPeriodEnd;
}
