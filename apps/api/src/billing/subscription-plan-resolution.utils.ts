import { Prisma } from '@prisma/client';

/** Stripe params for an immediate paid upgrade on an existing subscription. */
export const STRIPE_IMMEDIATE_UPGRADE_PARAMS = {
  proration_behavior: 'always_invoice' as const,
  payment_behavior: 'pending_if_incomplete' as const,
};

/**
 * Stripe billing semantics (API 2025-08-27.basil):
 *
 * - `create_prorations` alone creates proration line items but does NOT necessarily
 *   invoice/collect them immediately.
 * - `always_invoice` creates prorations AND invoices immediately.
 * - `pending_if_incomplete` applies the subscription update only if that invoice payment
 *   succeeds; otherwise Stripe keeps the prior subscription state (pending_update).
 *
 * Example: Basic MX$1,300 → Full MX$1,500 mid-cycle (Aug 15, period Aug 1–31):
 * - Stripe computes proration for unused Basic + remaining Full days (authoritative amount).
 * - An invoice is created immediately for that proration delta.
 * - If payment succeeds: subscription item price becomes Full; next renewal ≈ Aug 31 at MX$1,500.
 * - If payment fails: subscription stays on Basic price; no effective plan change locally.
 *
 * GymOS does NOT hardcode proration amounts — Stripe invoices are source of truth.
 */
export function buildImmediateUpgradeUpdateParams(input: {
  subscriptionItemId: string;
  newPriceId: string;
  metadata: Record<string, string>;
}) {
  return {
    cancel_at_period_end: false,
    items: [{ id: input.subscriptionItemId, price: input.newPriceId }],
    metadata: input.metadata,
    ...STRIPE_IMMEDIATE_UPGRADE_PARAMS,
  };
}

export type StripeSubscriptionPriceSnapshot = {
  items?: {
    data?: Array<{
      price?: { id: string } | string | null;
    }>;
  } | null;
};

export function readCurrentStripePriceId(sub: StripeSubscriptionPriceSnapshot): string | null {
  const price = sub.items?.data?.[0]?.price;
  if (!price) return null;
  return typeof price === 'string' ? price : price.id;
}

export async function resolvePlanIdForStripePrice(
  prisma: Prisma.TransactionClient | {
    membershipPlan: {
      findFirst: (args: {
        where: { stripePriceId: string; deletedAt: null };
        select: { id: true };
      }) => Promise<{ id: string } | null>;
    };
  },
  stripePriceId: string | null,
): Promise<string | null> {
  if (!stripePriceId) return null;
  const plan = await prisma.membershipPlan.findFirst({
    where: { stripePriceId, deletedAt: null },
    select: { id: true },
  });
  return plan?.id ?? null;
}

export function readPendingPlanIdFromMetadata(
  metadata: Record<string, string> | null | undefined,
): string | null {
  if (!metadata) return null;
  return metadata['pendingPlanId'] ?? null;
}
