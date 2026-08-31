import { randomUUID } from 'node:crypto';
import {
  GYMOS_RENEWAL_IDEMPOTENCY_PREFIX,
  GYMOS_STRIPE_TO_CASH_IDEMPOTENCY_PREFIX,
  STRIPE_RENEWAL_DISABLED,
  STRIPE_RENEWAL_REACTIVATED,
  type StripeRenewalSourceSurface,
} from './stripe-renewal-audit.constants';

export function buildGymosRenewalIdempotencyKey(nonce: string = randomUUID()): string {
  return `${GYMOS_RENEWAL_IDEMPOTENCY_PREFIX}${nonce}`;
}

/** Deterministic Stripe→Cash CAPE key — stable across retries of the same transition. */
export function buildGymosStripeToCashPeriodEndIdempotencyKey(
  stripeSubscriptionId: string,
): string {
  return `${GYMOS_STRIPE_TO_CASH_IDEMPOTENCY_PREFIX}${stripeSubscriptionId}_cancel_at_period_end`;
}

/** Deterministic Stripe→Cash immediate-cancel key. */
export function buildGymosStripeToCashImmediateIdempotencyKey(
  stripeSubscriptionId: string,
): string {
  return `${GYMOS_STRIPE_TO_CASH_IDEMPOTENCY_PREFIX}${stripeSubscriptionId}_cancel_immediate`;
}

/** @deprecated Prefer period-end / immediate builders; kept for prefix tests. */
export function buildGymosStripeToCashIdempotencyKey(nonce: string = randomUUID()): string {
  return `${GYMOS_STRIPE_TO_CASH_IDEMPOTENCY_PREFIX}${nonce}`;
}

export function isGymosInitiatedStripeIdempotencyKey(
  idempotencyKey: string | null | undefined,
): boolean {
  if (!idempotencyKey) return false;
  return (
    idempotencyKey.startsWith(GYMOS_RENEWAL_IDEMPOTENCY_PREFIX) ||
    idempotencyKey.startsWith(GYMOS_STRIPE_TO_CASH_IDEMPOTENCY_PREFIX)
  );
}

export function gymosRenewalActionForCancel(
  cancelAtPeriodEnd: boolean,
): typeof STRIPE_RENEWAL_DISABLED | typeof STRIPE_RENEWAL_REACTIVATED {
  return cancelAtPeriodEnd ? STRIPE_RENEWAL_DISABLED : STRIPE_RENEWAL_REACTIVATED;
}

export function readJsonMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function readCancellationDetails(sub: {
  cancellation_details?: {
    reason?: string | null;
    feedback?: string | null;
    comment?: string | null;
  } | null;
}): { reason: string | null; feedback: string | null; comment: string | null } {
  const details = sub.cancellation_details;
  return {
    reason: details?.reason ?? null,
    feedback: details?.feedback ?? null,
    comment: details?.comment ?? null,
  };
}

export type GymosRenewalAuditMetadata = {
  studioId: string;
  memberUserId: string;
  subscriptionId: string;
  stripeSubscriptionId: string;
  actorUserId: string;
  actorRole: string | null;
  origin: 'GYMOS';
  previousCancelAtPeriodEnd: boolean;
  newCancelAtPeriodEnd: boolean;
  effectiveAt: string;
  currentPeriodEnd: string | null;
  sourceSurface: StripeRenewalSourceSurface;
  stripeIdempotencyKey: string;
  stripeRequestId: string | null;
  timestamp: string;
};

export type ExternalRenewalAuditMetadata = {
  studioId: string;
  memberUserId: string;
  subscriptionId: string;
  stripeSubscriptionId: string;
  actorUserId: null;
  origin: 'STRIPE_EXTERNAL';
  previousCancelAtPeriodEnd: boolean;
  newCancelAtPeriodEnd: boolean;
  stripeEventId: string;
  stripeEventType: string;
  stripeRequestId: string | null;
  stripeIdempotencyKey: string | null;
  cancellationReason: string | null;
  cancellationFeedback: string | null;
  currentPeriodEnd: string | null;
  receivedAt: string;
};

/** Operator-facing Spanish timeline copy — never invents a human actor for external events. */
export function describeStripeRenewalTimelineEvent(input: {
  action: string;
  metadata: Record<string, unknown>;
  actorName: string | null;
}): { title: string; description: string; actor: string | null } {
  const prev = Boolean(input.metadata['previousCancelAtPeriodEnd']);
  const next = Boolean(input.metadata['newCancelAtPeriodEnd']);
  const renewalDelta = `Renovación automática: ${prev ? 'Desactivada' : 'Activada'} → ${next ? 'Desactivada' : 'Activada'}`;
  const feedback =
    typeof input.metadata['cancellationFeedback'] === 'string' && input.metadata['cancellationFeedback']
      ? ` · Stripe reportó feedback: ${input.metadata['cancellationFeedback']}`
      : '';

  if (input.action === STRIPE_RENEWAL_DISABLED) {
    return {
      title: 'Renovación automática desactivada',
      description: `Desde GymOS · ${renewalDelta}`,
      actor: input.actorName,
    };
  }
  if (input.action === STRIPE_RENEWAL_REACTIVATED) {
    return {
      title: 'Renovación automática reactivada',
      description: `Desde GymOS · ${renewalDelta}`,
      actor: input.actorName,
    };
  }
  return {
    title: 'Renovación modificada desde Stripe',
    description: `Origen externo · actor no identificado · ${renewalDelta}${feedback}`,
    actor: null,
  };
}
