import { PaymentMethod, PaymentStatus, SubscriptionSource, type Prisma } from '@prisma/client';

/**
 * READ-ONLY detection of the 2026-10-02 incident state: a SUCCEEDED Stripe payment for a
 * fixed-duration (entitlementDays) membership whose invoice never produced an entitlement cycle
 * — the member paid but has no access. Used by Member 360, the studio reconciliation audit and the
 * recovery dry-run. Never writes.
 */

/** Cycle ids written by the 20260820020000 migration backfill. */
export const LEGACY_BACKFILL_CYCLE_ID_PREFIX = 'backfill_';
/**
 * The entitlement-cycle ledger (migration 20260820020000) did not exist before this instant.
 * Earlier payments were never meant to carry their own cycle (the backfill wrote at most one per
 * subscription), so they cannot be "paid without entitlement" and are not evaluated.
 */
export const ENTITLEMENT_LEDGER_STARTED_AT = new Date('2026-08-20T00:00:00.000Z');
/**
 * The backfill linked a cycle to its invoice only when the subscription had exactly one Stripe
 * payment. A backfilled cycle WITHOUT an invoice link that starts within this window of a payment
 * is treated as that payment's cycle, so legacy history never reads as an open incident.
 */
const LEGACY_BACKFILL_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PaidPaymentRef = {
  id: string;
  userId: string;
  subscriptionId: string | null;
  membershipPlanId: string | null;
  stripeInvoiceId: string | null;
  amountCents: number;
  currency: string;
  paidAt: Date | null;
  createdAt: Date;
};

export type FixedDurationSubscriptionRef = { id: string; userId: string; membershipPlanId: string };

export type CycleRef = {
  id: string;
  subscriptionId: string;
  startsAt: Date;
  stripeInvoiceId: string | null;
};

export type PaidWithoutEntitlement = {
  paymentId: string;
  userId: string;
  /** Resolved local subscription (null when the payment cannot be attributed to one). */
  subscriptionId: string | null;
  stripeInvoiceId: string;
  amountCents: number;
  currency: string;
  paidAt: Date;
};

export function findPaidWithoutEntitlement(input: {
  payments: PaidPaymentRef[];
  fixedDurationSubscriptions: FixedDurationSubscriptionRef[];
  fixedDurationPlanIds: string[];
  cycles: CycleRef[];
  /**
   * Invoices an operator explicitly acknowledged as needing no cycle (e.g. refunded), recorded as
   * `resolved_at` on the invoice's stored invoice.paid event. Never inferred automatically.
   */
  acknowledgedInvoiceIds?: Iterable<string>;
}): PaidWithoutEntitlement[] {
  const fixedSubs = new Map(input.fixedDurationSubscriptions.map((s) => [s.id, s]));
  const fixedPlans = new Set(input.fixedDurationPlanIds);
  const invoicesWithCycle = new Set(input.cycles.map((c) => c.stripeInvoiceId).filter((id): id is string => !!id));
  const acknowledged = new Set(input.acknowledgedInvoiceIds ?? []);

  const findings: PaidWithoutEntitlement[] = [];
  for (const payment of input.payments) {
    if (!payment.stripeInvoiceId || payment.amountCents <= 0) continue;
    if (invoicesWithCycle.has(payment.stripeInvoiceId) || acknowledged.has(payment.stripeInvoiceId)) continue;
    if ((payment.paidAt ?? payment.createdAt) < ENTITLEMENT_LEDGER_STARTED_AT) continue;

    let subscriptionId: string | null = null;
    if (payment.subscriptionId) {
      if (!fixedSubs.has(payment.subscriptionId)) continue; // not a fixed-duration membership payment
      subscriptionId = payment.subscriptionId;
    } else {
      if (!payment.membershipPlanId || !fixedPlans.has(payment.membershipPlanId)) continue;
      // Unlinked payment (invoice raced ahead of its subscription row): attribute it only when
      // the member has exactly one fixed-duration subscription on that plan.
      const candidates = input.fixedDurationSubscriptions.filter(
        (s) => s.userId === payment.userId && s.membershipPlanId === payment.membershipPlanId,
      );
      subscriptionId = candidates.length === 1 ? candidates[0].id : null;
    }

    const paidAt = payment.paidAt ?? payment.createdAt;
    const coveredByLegacyBackfill =
      subscriptionId !== null &&
      input.cycles.some(
        (c) =>
          c.subscriptionId === subscriptionId &&
          c.stripeInvoiceId === null &&
          c.id.startsWith(LEGACY_BACKFILL_CYCLE_ID_PREFIX) &&
          Math.abs(c.startsAt.getTime() - paidAt.getTime()) <= LEGACY_BACKFILL_MATCH_WINDOW_MS,
      );
    if (coveredByLegacyBackfill) continue;

    findings.push({
      paymentId: payment.id,
      userId: payment.userId,
      subscriptionId,
      stripeInvoiceId: payment.stripeInvoiceId,
      amountCents: payment.amountCents,
      currency: payment.currency,
      paidAt,
    });
  }
  return findings.sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime());
}

/** Minimal read surface — callers may pass a read-only transaction client. */
export type PaidWithoutEntitlementReader = Pick<
  Prisma.TransactionClient,
  'membershipPlan' | 'subscription' | 'payment' | 'membershipEntitlementCycle' | 'stripeWebhookEvent'
>;

/**
 * Loads and evaluates one studio (optionally one member). Issues only `findMany` reads.
 * Returns [] immediately when the studio has no fixed-duration plan.
 */
export async function loadPaidWithoutEntitlement(
  db: PaidWithoutEntitlementReader,
  scope: { studioId: string; userId?: string },
): Promise<PaidWithoutEntitlement[]> {
  const fixedPlans = await db.membershipPlan.findMany({
    where: { studioId: scope.studioId, entitlementDays: { not: null } },
    select: { id: true },
  });
  if (fixedPlans.length === 0) return [];
  const fixedDurationPlanIds = fixedPlans.map((p) => p.id);

  const fixedDurationSubscriptions = await db.subscription.findMany({
    where: {
      studioId: scope.studioId,
      ...(scope.userId ? { userId: scope.userId } : {}),
      source: SubscriptionSource.STRIPE,
      membershipPlanId: { in: fixedDurationPlanIds },
    },
    select: { id: true, userId: true, membershipPlanId: true },
  });
  const subscriptionIds = fixedDurationSubscriptions.map((s) => s.id);

  const payments = await db.payment.findMany({
    where: {
      studioId: scope.studioId,
      ...(scope.userId ? { userId: scope.userId } : {}),
      status: PaymentStatus.SUCCEEDED,
      paymentMethod: PaymentMethod.STRIPE,
      stripeInvoiceId: { not: null },
      amountCents: { gt: 0 },
      OR: [
        { subscriptionId: { in: subscriptionIds } },
        { subscriptionId: null, membershipPlanId: { in: fixedDurationPlanIds } },
      ],
    },
    select: {
      id: true, userId: true, subscriptionId: true, membershipPlanId: true, stripeInvoiceId: true,
      amountCents: true, currency: true, paidAt: true, createdAt: true,
    },
  });
  if (payments.length === 0) return [];

  const invoiceIds = payments.map((p) => p.stripeInvoiceId).filter((id): id is string => !!id);
  const cycles = await db.membershipEntitlementCycle.findMany({
    where: {
      OR: [
        { subscriptionId: { in: subscriptionIds } },
        { stripeInvoiceId: { in: invoiceIds } },
      ],
    },
    select: { id: true, subscriptionId: true, startsAt: true, stripeInvoiceId: true },
  });

  const candidates = findPaidWithoutEntitlement({ payments, fixedDurationSubscriptions, fixedDurationPlanIds, cycles });
  if (candidates.length === 0) return [];
  // Existence checks only: stored payloads (which hold customer data) are never loaded.
  const acknowledgedInvoiceIds: string[] = [];
  for (const candidate of candidates) {
    const acknowledged = await db.stripeWebhookEvent.findFirst({
      where: {
        eventType: 'invoice.paid',
        resolvedAt: { not: null },
        payload: { path: ['data', 'object', 'id'], equals: candidate.stripeInvoiceId },
      },
      select: { id: true },
    });
    if (acknowledged) acknowledgedInvoiceIds.push(candidate.stripeInvoiceId);
  }
  return findPaidWithoutEntitlement({
    payments, fixedDurationSubscriptions, fixedDurationPlanIds, cycles, acknowledgedInvoiceIds,
  });
}
