/**
 * Authoritative recurring price for a membership row.
 *
 * Catalog `MembershipPlan.priceCents` is for NEW sales only. Once a subscription
 * exists, `Subscription.priceCents` is the agreed lock — grandfathering, renewals,
 * and member-facing displays must use this value and never silently fall forward
 * to a later catalog increase.
 *
 * Display reads may fall back to catalog when a pre-backfill row has a null lock
 * so UIs stay defined. Payment creation MUST use `resolveAuthorizedSalePriceCents`
 * / `resolveStampedSalePriceCents`, which refuse that fallback for renewals.
 */

export class MissingSubscriptionPriceLockError extends Error {
  constructor(message = 'Existing membership is missing a locked priceCents') {
    super(message);
    this.name = 'MissingSubscriptionPriceLockError';
  }
}

/**
 * Display / projection helper. Prefer the lock; catalog only when lock is null
 * so Member 360 stays defined. Do not use for authorizing or stamping charges.
 */
export function effectiveSubscriptionPriceCents(params: {
  subscriptionPriceCents: number | null | undefined;
  catalogPriceCents: number;
}): number {
  return params.subscriptionPriceCents ?? params.catalogPriceCents;
}

/**
 * Cash / offline sale authorization amount.
 *
 * - No held renewable row → catalog (new membership / first cash sale).
 * - Held row with a lock → that lock (grandfathered renewals stay at 1500).
 * - Held row with a missing lock → refuse; never authorize catalog.
 */
export function resolveAuthorizedSalePriceCents(params: {
  heldSubscription: { priceCents: number | null } | null | undefined;
  catalogPriceCents: number;
}): number {
  if (!params.heldSubscription) {
    return params.catalogPriceCents;
  }
  if (params.heldSubscription.priceCents == null) {
    throw new MissingSubscriptionPriceLockError();
  }
  return params.heldSubscription.priceCents;
}

/**
 * Lock to stamp on a newly created cash subscription row after a sale.
 *
 * Owner amount overrides do not rewrite an existing lock. A missing lock is
 * never filled from catalog — only an explicit owner override may stamp the
 * charged amount as the new agreed lock.
 */
export function resolveStampedSalePriceCents(params: {
  heldSubscription: { priceCents: number | null } | null | undefined;
  catalogPriceCents: number;
  chargedAmountCents: number;
  ownerOverride: boolean;
}): number {
  if (!params.heldSubscription) {
    return params.catalogPriceCents;
  }
  if (params.heldSubscription.priceCents != null) {
    return params.heldSubscription.priceCents;
  }
  if (params.ownerOverride) {
    return params.chargedAmountCents;
  }
  throw new MissingSubscriptionPriceLockError();
}

export function isGrandfatheredBelowCatalog(params: {
  subscriptionPriceCents: number | null | undefined;
  catalogPriceCents: number;
}): boolean {
  if (params.subscriptionPriceCents == null) return false;
  return params.subscriptionPriceCents < params.catalogPriceCents;
}
