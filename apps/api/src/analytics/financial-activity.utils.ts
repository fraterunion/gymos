import {
  PaymentMethod,
  PaymentStatus,
  SubscriptionStatus,
} from '@prisma/client';
import type {
  FinancialActivityEventType,
  FinancialActivityMethod,
  FinancialActivityStatus,
  FirstSucceededPaymentIndex,
} from './financial-activity.types';

export const FINANCIAL_ACTIVITY_DEFAULT_LIMIT = 25;
export const FINANCIAL_ACTIVITY_MAX_LIMIT = 100;

/**
 * Historical enrollment fallback — only when payment.subscriptionId is NULL.
 * All conditions must match; timestamp proximity alone is never sufficient.
 */
export const HISTORICAL_ENROLLMENT_MAX_OFFSET_MS = 24 * 60 * 60 * 1000;

export function financialActivityEventLabel(type: FinancialActivityEventType): string {
  switch (type) {
    case 'new_membership':
      return 'Nueva membresía';
    case 'membership_renewal':
      return 'Renovación de membresía';
    case 'one_time_payment':
      return 'Pago único';
    case 'payment_failed':
      return 'Pago fallido';
    case 'refund':
      return 'Reembolso';
    case 'trial_started':
      return 'Inicio de prueba';
    case 'subscription_cancelled':
      return 'Cancelación';
    default:
      return 'Movimiento';
  }
}

export function financialActivityStatusLabel(status: FinancialActivityStatus): string {
  switch (status) {
    case 'collected':
      return 'Cobrado';
    case 'pending':
      return 'Pendiente';
    case 'failed':
      return 'Fallido';
    case 'refunded':
      return 'Reembolsado';
    case 'cancelled':
      return 'Cancelado';
    default:
      return status;
  }
}

export function financialActivityMethodLabel(method: FinancialActivityMethod): string {
  switch (method) {
    case 'stripe':
      return 'Stripe';
    case 'cash':
      return 'Efectivo';
    case 'terminal':
      return 'Terminal';
    case 'transfer':
      return 'Transferencia';
    case 'other':
      return 'Otro';
    default:
      return 'Otro';
  }
}

export function mapPaymentMethod(method: PaymentMethod | null | undefined): FinancialActivityMethod {
  switch (method) {
    case PaymentMethod.STRIPE:
      return 'stripe';
    case PaymentMethod.CASH:
      return 'cash';
    case PaymentMethod.TERMINAL:
      return 'terminal';
    default:
      return 'other';
  }
}

export function mapPaymentStatus(status: PaymentStatus): FinancialActivityStatus {
  switch (status) {
    case PaymentStatus.SUCCEEDED:
      return 'collected';
    case PaymentStatus.PENDING:
      return 'pending';
    case PaymentStatus.FAILED:
      return 'failed';
    case PaymentStatus.REFUNDED:
    case PaymentStatus.PARTIALLY_REFUNDED:
      return 'refunded';
    default:
      return 'pending';
  }
}

export type PaymentActivityInput = {
  id: string;
  studioId?: string;
  userId?: string;
  membershipPlanId?: string | null;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  paymentMethod: PaymentMethod;
  paidAt: Date | null;
  createdAt: Date;
  notes: string | null;
  subscriptionId: string | null;
  user: { id: string; firstName: string; lastName: string } | null;
  membershipPlan: { name: string; priceCents?: number } | null;
  subscription: {
    id: string;
    status: SubscriptionStatus;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: Date | null;
    createdAt: Date;
    userId?: string;
    membershipPlanId?: string;
  } | null;
};

export type SubscriptionActivityInput = {
  id: string;
  studioId: string;
  userId: string;
  membershipPlanId: string;
  status: SubscriptionStatus;
  createdAt: Date;
  updatedAt: Date;
  membershipPlan: { name: string; priceCents: number; currency: string };
};

/** Canonical identity for payment-derived rows. */
export function paymentDedupKey(paymentId: string): string {
  return `payment:${paymentId}`;
}

export function subscriptionTrialDedupKey(subscriptionId: string): string {
  return `subscription-trial:${subscriptionId}`;
}

export function subscriptionCancelDedupKey(subscriptionId: string, occurredAt: Date): string {
  return `subscription-cancel:${subscriptionId}:${occurredAt.toISOString()}`;
}

/**
 * Primary rule: payment is first on subscription when its id equals the earliest
 * SUCCEEDED payment id for that subscription (from bounded index query).
 */
export function isFirstSucceededPaymentOnSubscription(
  payment: PaymentActivityInput,
  firstSucceededPaymentIdBySub: FirstSucceededPaymentIndex,
): boolean {
  if (!payment.subscriptionId) return false;
  if (payment.status !== PaymentStatus.SUCCEEDED) return false;
  const firstId = firstSucceededPaymentIdBySub.get(payment.subscriptionId);
  return firstId === payment.id;
}

/**
 * Explicit payment event classifier — method is independent from business event.
 */
export function classifyPaymentEventType(
  payment: PaymentActivityInput,
  isFirstSucceeded: boolean,
): FinancialActivityEventType {
  if (payment.status === PaymentStatus.FAILED) return 'payment_failed';
  if (
    payment.status === PaymentStatus.REFUNDED ||
    payment.status === PaymentStatus.PARTIALLY_REFUNDED
  ) {
    return 'refund';
  }

  if (payment.subscriptionId) {
    return isFirstSucceeded ? 'new_membership' : 'membership_renewal';
  }

  return 'one_time_payment';
}

export function resolveNextRenewalAt(subscription: PaymentActivityInput['subscription']): string | null {
  if (!subscription) return null;
  if (subscription.status !== SubscriptionStatus.ACTIVE) return null;
  if (subscription.cancelAtPeriodEnd) return null;
  if (!subscription.currentPeriodEnd) return null;
  return subscription.currentPeriodEnd.toISOString();
}

export function encodeActivityCursor(occurredAt: string, id: string): string {
  return Buffer.from(`${occurredAt}|${id}`, 'utf8').toString('base64url');
}

export function decodeActivityCursor(cursor: string): { occurredAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep <= 0) return null;
    return { occurredAt: raw.slice(0, sep), id: raw.slice(sep + 1) };
  } catch {
    return null;
  }
}

export function matchesCategoryFilter(
  category: string | undefined,
  item: {
    method: FinancialActivityMethod;
    eventType: FinancialActivityEventType;
    status: FinancialActivityStatus;
  },
): boolean {
  if (!category || category === 'all') return true;
  switch (category) {
    case 'stripe':
      return item.method === 'stripe';
    case 'cash':
      return item.method === 'cash';
    case 'renewals':
      return item.eventType === 'membership_renewal';
    case 'failed':
      return item.status === 'failed';
    case 'refunds':
      return item.eventType === 'refund' || item.status === 'refunded';
    default:
      return true;
  }
}

/**
 * Primary subscription suppression: any payment with subscriptionId === subscription.id
 * makes the payment row canonical — no parallel subscription enrollment activity row.
 */
export function subscriptionHasLinkedPayment(
  subscriptionId: string,
  payments: PaymentActivityInput[],
): boolean {
  return payments.some((p) => p.subscriptionId === subscriptionId);
}

/**
 * Historical fallback — only when payment.subscriptionId is missing.
 * Requires member, studio, plan, amount, and enrollment timestamp alignment.
 * Does NOT deduplicate on timestamp proximity alone.
 */
export function matchesHistoricalEnrollmentPayment(
  payment: PaymentActivityInput,
  subscription: SubscriptionActivityInput,
): boolean {
  if (payment.subscriptionId) return false;
  if (payment.status !== PaymentStatus.SUCCEEDED) return false;
  if (!payment.user || payment.user.id !== subscription.userId) return false;
  if (payment.studioId && payment.studioId !== subscription.studioId) return false;
  if (
    payment.membershipPlanId &&
    payment.membershipPlanId !== subscription.membershipPlanId
  ) {
    return false;
  }
  if (payment.amountCents !== subscription.membershipPlan.priceCents) return false;

  const paymentAt = (payment.paidAt ?? payment.createdAt).getTime();
  const subAt = subscription.createdAt.getTime();
  const offset = Math.abs(paymentAt - subAt);
  if (offset > HISTORICAL_ENROLLMENT_MAX_OFFSET_MS) return false;

  return true;
}

/** Suppress subscription trial row when a linked or historically matched payment exists. */
export function shouldSuppressSubscriptionTrialRow(
  subscription: SubscriptionActivityInput,
  payments: PaymentActivityInput[],
): boolean {
  if (subscriptionHasLinkedPayment(subscription.id, payments)) return true;
  return payments.some((p) => matchesHistoricalEnrollmentPayment(p, subscription));
}

export function paymentFailureReason(notes: string | null): string | null {
  const trimmed = notes?.trim();
  if (!trimmed) return null;
  return trimmed;
}

/** Build index from SQL rows — one row per subscription with earliest succeeded payment id. */
export function indexFirstSucceededPayments(
  rows: Array<{ subscription_id: string; first_payment_id: string }>,
): FirstSucceededPaymentIndex {
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.subscription_id, row.first_payment_id);
  }
  return map;
}
