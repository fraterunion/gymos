import { SubscriptionStatus } from '@prisma/client';
import { isClassIncludedInPlan } from '../membership-plans/membership-plan-class-access.utils';
import { orderEntitlementCandidates } from '../memberships/membership-compatibility';

/**
 * MM-5.1 — deterministic attribution of LEGACY consumption rows (subscriptionId NULL).
 *
 * P0 invariant: one consumption event contributes to AT MOST ONE subscription ledger.
 * Explicit attribution (subscriptionId != NULL) is authoritative and is never re-inferred.
 * A legacy NULL event is assigned to exactly one deterministic owner computed from the
 * member's FULL candidate set — so independent per-subscription queries always agree
 * (query symmetry): counting subscription A and counting subscription B both derive the
 * same owner from the same static facts, and the event lands in exactly one ledger.
 *
 * The owner rule is static and query-independent:
 *   1. collapse Booking/Attendance rows into one canonical event per scheduled class
 *      (explicit attribution wins over NULL; booking attribution wins over a conflicting
 *      attendance attribution — conflicts are surfaced, never double-charged)
 *   2. candidates = the member's subscriptions whose recorded entitlement window covers
 *      the CLASS START (never remaining credits, never query order)
 *   3. prefer candidates whose plan actually includes the class (template/category/all),
 *      falling back to all window-covering candidates so single-membership history keeps
 *      today's counts exactly
 *   4. order by the SAME canonical precedence bookings use at authorization time
 *      (orderEntitlementCandidates: unlimited first, then soonest-ending entitlement,
 *      then createdAt, then id) and take the first — a total, stable order.
 *
 * No database backfill: this is runtime inference for historical NULL rows only; every
 * new consumption write remains explicitly attributed at authorization time.
 */

export type ConsumptionLegSource = 'booking' | 'attendance';

export type ConsumptionLegRow = {
  classId: string;
  startsAt: Date;
  classTemplateId: string;
  templateCategory: string | null;
  source: ConsumptionLegSource;
  subscriptionId: string | null;
};

export type CanonicalConsumptionEvent = {
  classId: string;
  startsAt: Date;
  classTemplateId: string;
  templateCategory: string | null;
  /** Non-null = authoritative explicit attribution; null = legacy event needing inference. */
  attributedSubscriptionId: string | null;
};

export type ExplicitAttributionConflict = {
  classId: string;
  bookingSubscriptionId: string;
  attendanceSubscriptionId: string;
};

/**
 * One scheduled class = at most one consumption event. Explicit attribution on either
 * leg wins over NULL; when booking and attendance carry DIFFERENT explicit attributions
 * (impossible by design — attendance inherits from the booking), the booking's
 * authorization-time attribution wins deterministically and the conflict is reported.
 */
export function collapseConsumptionRows(rows: readonly ConsumptionLegRow[]): {
  events: CanonicalConsumptionEvent[];
  conflicts: ExplicitAttributionConflict[];
} {
  const byClass = new Map<string, ConsumptionLegRow[]>();
  for (const row of rows) {
    const list = byClass.get(row.classId) ?? [];
    list.push(row);
    byClass.set(row.classId, list);
  }

  const events: CanonicalConsumptionEvent[] = [];
  const conflicts: ExplicitAttributionConflict[] = [];
  for (const [classId, legs] of byClass) {
    const first = legs[0]!;
    const bookingExplicit = legs.find((l) => l.source === 'booking' && l.subscriptionId !== null)?.subscriptionId ?? null;
    const attendanceExplicit = legs.find((l) => l.source === 'attendance' && l.subscriptionId !== null)?.subscriptionId ?? null;
    if (bookingExplicit !== null && attendanceExplicit !== null && bookingExplicit !== attendanceExplicit) {
      conflicts.push({ classId, bookingSubscriptionId: bookingExplicit, attendanceSubscriptionId: attendanceExplicit });
    }
    events.push({
      classId,
      startsAt: first.startsAt,
      classTemplateId: first.classTemplateId,
      templateCategory: first.templateCategory,
      attributedSubscriptionId: bookingExplicit ?? attendanceExplicit,
    });
  }
  return { events, conflicts };
}

export type LegacyOwnershipCandidate = {
  id: string;
  status: SubscriptionStatus;
  createdAt: Date;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  entitlementEndsAt: Date | null;
  membershipPlan: {
    classCredits: number | null;
    allClassesAccess: boolean;
    allowedCategories: string[];
    allowedTemplateIds: string[];
  };
};

/**
 * Static historical eligibility: the subscription's recorded entitlement window covers
 * the class start. SCHEDULED successors never granted access and are excluded;
 * CANCELED-but-entitled history stays eligible via entitlementEndsAt. Null bounds are
 * open (a row with no recorded start/end never blocks its own history).
 */
export function candidateWindowCovers(
  candidate: Pick<LegacyOwnershipCandidate, 'status' | 'currentPeriodStart' | 'currentPeriodEnd' | 'entitlementEndsAt'>,
  classStartsAt: Date,
): boolean {
  if (candidate.status === SubscriptionStatus.SCHEDULED) return false;
  const start = candidate.currentPeriodStart;
  const end = candidate.entitlementEndsAt ?? candidate.currentPeriodEnd;
  if (start !== null && classStartsAt < start) return false;
  if (end !== null && classStartsAt >= end) return false;
  return true;
}

/**
 * The ONE deterministic owner of a legacy NULL event, or null when no candidate's
 * window covers the class (the event then contributes to no ledger).
 * Independent of remaining credits and of which subscription's ledger is being queried.
 */
export function resolveLegacyEventOwner(
  event: Pick<CanonicalConsumptionEvent, 'startsAt' | 'classTemplateId' | 'templateCategory'>,
  candidates: readonly LegacyOwnershipCandidate[],
): string | null {
  const covering = candidates.filter((c) => candidateWindowCovers(c, event.startsAt));
  if (covering.length === 0) return null;
  const qualifying = covering.filter((c) =>
    isClassIncludedInPlan({
      allClassesAccess: c.membershipPlan.allClassesAccess,
      allowedTemplateIds: c.membershipPlan.allowedTemplateIds,
      // Category values are persisted enum strings; the access check compares them
      // structurally, so plain strings are the honest wire type here.
      allowedCategories: c.membershipPlan.allowedCategories as never[],
      classTemplateId: event.classTemplateId,
      templateCategory: event.templateCategory as never,
    }),
  );
  // Access-qualifying candidates are preferred; falling back to window-covering keeps
  // single-membership history (including override/walk-in classes outside the plan's
  // template list) counting exactly as it always has.
  const pool = qualifying.length > 0 ? qualifying : covering;
  const ordered = orderEntitlementCandidates(pool);
  return ordered[0]!.id;
}

/**
 * Ledger membership test for one canonical event against one queried subscription —
 * the single rule both counting and existence checks share.
 */
export function eventBelongsToSubscription(
  event: CanonicalConsumptionEvent,
  queriedSubscriptionId: string,
  candidates: readonly LegacyOwnershipCandidate[],
): boolean {
  if (event.attributedSubscriptionId !== null) {
    return event.attributedSubscriptionId === queriedSubscriptionId;
  }
  return resolveLegacyEventOwner(event, candidates) === queriedSubscriptionId;
}
