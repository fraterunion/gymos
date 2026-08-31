/** GymOS-initiated: staff disabled auto-renewal (cancel_at_period_end → true). */
export const STRIPE_RENEWAL_DISABLED = 'STRIPE_RENEWAL_DISABLED';

/** GymOS-initiated: staff re-enabled auto-renewal (cancel_at_period_end → false). */
export const STRIPE_RENEWAL_REACTIVATED = 'STRIPE_RENEWAL_REACTIVATED';

/**
 * Stripe Portal / Dashboard / unknown API change mirrored via webhook.
 * actorUserId is always null — do not invent a member or staff actor.
 */
export const STRIPE_RENEWAL_EXTERNAL_CHANGE = 'STRIPE_RENEWAL_EXTERNAL_CHANGE';

/** Authoritative Stripe→Cash audits — correlators treat these as GymOS-initiated CAPE changes. */
export const STRIPE_TO_CASH_PERIOD_END_SCHEDULED = 'STRIPE_TO_CASH_PERIOD_END_SCHEDULED';
export const STRIPE_TO_CASH_IMMEDIATE = 'STRIPE_TO_CASH_IMMEDIATE';

export const STRIPE_RENEWAL_AUDIT_ACTIONS = [
  STRIPE_RENEWAL_DISABLED,
  STRIPE_RENEWAL_REACTIVATED,
  STRIPE_RENEWAL_EXTERNAL_CHANGE,
] as const;

export type StripeRenewalAuditAction = (typeof STRIPE_RENEWAL_AUDIT_ACTIONS)[number];

export type StripeRenewalOrigin = 'GYMOS' | 'STRIPE_EXTERNAL';

/**
 * Provenance of a GymOS-initiated renewal mutation.
 * Must match the real UI/API surface — never invent Member 360 when the call
 * came from Memberships list (or vice versa).
 */
export const STRIPE_RENEWAL_SOURCE_SURFACES = [
  'ADMIN_MEMBERSHIPS',
  'ADMIN_MEMBER_360',
  'MOBILE_STAFF_SALES',
  'STRIPE_TO_CASH_TRANSITION',
  'SYSTEM_RECONCILIATION',
  'OTHER_GYMOS_API',
] as const;

export type StripeRenewalSourceSurface = (typeof STRIPE_RENEWAL_SOURCE_SURFACES)[number];

/** Stripe RequestOptions.idempotencyKey prefixes — webhooks treat these as GymOS-initiated. */
export const GYMOS_RENEWAL_IDEMPOTENCY_PREFIX = 'gymos_renewal_';
export const GYMOS_STRIPE_TO_CASH_IDEMPOTENCY_PREFIX = 'gymos_stripe_to_cash_';
