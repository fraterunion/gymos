export const DAY_MS = 86_400_000;

export type FixedEntitlementCycle = {
  startsAt: Date;
  endsAt: Date;
  creditLimit: number | null;
};

/**
 * Converts one paid Stripe service period into one immutable GymOS entitlement cycle.
 * The provider period must exactly match the configured fixed duration. A late webhook
 * may fill a gap, but it may never overlap a previously granted cycle.
 */
export function buildPaidFixedEntitlementCycle(input: {
  periodStart: Date;
  periodEnd: Date;
  entitlementDays: number;
  creditLimit: number | null;
  previousCycleEnd?: Date | null;
}): FixedEntitlementCycle {
  const expectedMs = input.entitlementDays * DAY_MS;
  const actualMs = input.periodEnd.getTime() - input.periodStart.getTime();
  if (input.entitlementDays <= 0 || Math.abs(actualMs - expectedMs) > 1000) {
    throw new Error(`Provider period must equal ${input.entitlementDays} entitlement days`);
  }
  if (input.previousCycleEnd && input.periodStart < input.previousCycleEnd) {
    throw new Error('Paid entitlement cycle overlaps an existing cycle');
  }
  return {
    startsAt: new Date(input.periodStart),
    endsAt: new Date(input.periodEnd),
    creditLimit: input.creditLimit,
  };
}

export function cycleContains(cycle: FixedEntitlementCycle, at: Date): boolean {
  return at >= cycle.startsAt && at < cycle.endsAt;
}

export type ExistingEntitlementCycle = {
  id: string;
  subscriptionId: string;
  startsAt: Date;
  endsAt: Date;
  stripeInvoiceId: string | null;
};

/**
 * What to do with one paid, verified cycle candidate. Pure — the caller runs it inside the
 * transaction that holds the subscription's advisory locks, against rows read in that transaction.
 *
 * - `insert` / `live`: the candidate starts at or after every existing cycle; the subscription's
 *   current period and entitlement end move to it (normal renewal).
 * - `insert` / `historical_gap_fill`: the candidate fits a gap BEFORE a newer cycle (e.g. a
 *   recovered older invoice). It is inserted, but the subscription's current period is left on
 *   the newer cycle: no access is extended, no newer cycle is rewritten, no credits reset.
 * - `already_granted`: this invoice already has its identical cycle (webhook retry / replay).
 * - `already_covered`: an identical window exists without an invoice link (legacy migration
 *   backfill) — the period is already granted, so nothing is added.
 * - `reject`: the candidate collides with a different cycle; a human must decide.
 */
export type CycleInsertionPlan =
  | { action: 'insert'; mode: 'live' | 'historical_gap_fill'; cycle: FixedEntitlementCycle }
  | { action: 'already_granted'; existing: ExistingEntitlementCycle }
  | { action: 'already_covered'; existing: ExistingEntitlementCycle }
  | {
      action: 'reject';
      code: 'EXISTING_CYCLE_MISMATCH' | 'OVERLAPS_EXISTING_CYCLE';
      conflicting: ExistingEntitlementCycle;
    };

function sameWindow(a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }): boolean {
  return a.startsAt.getTime() === b.startsAt.getTime() && a.endsAt.getTime() === b.endsAt.getTime();
}

export function planPaidCycleInsertion(input: {
  subscriptionId: string;
  candidate: FixedEntitlementCycle;
  /** The cycle already linked to this Stripe invoice (unique), from any subscription. */
  existingForInvoice: ExistingEntitlementCycle | null;
  /** Every existing cycle of this subscription. */
  existingForSubscription: ExistingEntitlementCycle[];
}): CycleInsertionPlan {
  const { candidate } = input;
  if (input.existingForInvoice) {
    const existing = input.existingForInvoice;
    return existing.subscriptionId === input.subscriptionId && sameWindow(existing, candidate)
      ? { action: 'already_granted', existing }
      : { action: 'reject', code: 'EXISTING_CYCLE_MISMATCH', conflicting: existing };
  }

  // Half-open windows [startsAt, endsAt): adjacent cycles touch but never overlap, exactly like
  // the database trigger's tsrange(..., '[)') check.
  const overlapping = input.existingForSubscription.filter(
    (cycle) => cycle.startsAt < candidate.endsAt && cycle.endsAt > candidate.startsAt,
  );
  if (overlapping.length === 1 && sameWindow(overlapping[0], candidate) && overlapping[0].stripeInvoiceId === null) {
    return { action: 'already_covered', existing: overlapping[0] };
  }
  if (overlapping.length > 0) {
    return { action: 'reject', code: 'OVERLAPS_EXISTING_CYCLE', conflicting: overlapping[0] };
  }

  const latestEnd = input.existingForSubscription.reduce<number>(
    (max, cycle) => Math.max(max, cycle.endsAt.getTime()),
    Number.NEGATIVE_INFINITY,
  );
  return {
    action: 'insert',
    mode: candidate.startsAt.getTime() >= latestEnd ? 'live' : 'historical_gap_fill',
    cycle: candidate,
  };
}
