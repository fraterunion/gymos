/**
 * Authoritative recurring price for a membership row.
 *
 * Catalog `MembershipPlan.priceCents` is for NEW sales only. Once a subscription
 * exists, `Subscription.priceCents` is the agreed lock — grandfathering, renewals,
 * and member-facing displays must use this value and never silently fall forward
 * to a later catalog increase.
 *
 * Null lock (pre-backfill edge) falls back to catalog so reads stay defined.
 */
export function effectiveSubscriptionPriceCents(params: {
  subscriptionPriceCents: number | null | undefined;
  catalogPriceCents: number;
}): number {
  return params.subscriptionPriceCents ?? params.catalogPriceCents;
}

export function isGrandfatheredBelowCatalog(params: {
  subscriptionPriceCents: number | null | undefined;
  catalogPriceCents: number;
}): boolean {
  if (params.subscriptionPriceCents == null) return false;
  return params.subscriptionPriceCents < params.catalogPriceCents;
}
