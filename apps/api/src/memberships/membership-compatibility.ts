/**
 * MM-1 — the ONE canonical implementation of membership compatibility. Every surface that
 * decides whether two memberships may coexist (purchase gating, cash sales, Stripe webhooks,
 * reconciliation, Stripe→Cash correlation) must call these functions — never re-derive the
 * rules locally, and never compare plan NAMES.
 *
 * Rules:
 *   - Same plan            → always a conflict (renew/change, never a second row).
 *   - Same non-null group  → conflict (e.g. two 'CORE' plans: Full Access vs Basic).
 *   - Otherwise            → stackable (e.g. CORE + a NULL-group specialty like Booty Lab).
 *
 * Conflicts are evaluated against the SUBSCRIPTION's purchase-time snapshot
 * (exclusiveGroupKey) ONLY — never the plan's current exclusiveGroup — because editing a
 * plan's group later must not silently re-classify live rows. Every row is guaranteed a
 * snapshot: the MM-1 migration backfills all existing rows before the gate can ever turn
 * on, and every creation site writes it explicitly. Snapshot null = sold as stackable.
 *
 * MM-4 — gate semantics. MULTI_MEMBERSHIP_ENABLED answers exactly ONE question: "may the
 * system CREATE a new compatible simultaneous membership?" (allowNewMembershipStacks).
 * It is consulted ONLY at creation-acceptance sites, via findCreationConflicts. Family
 * relationships between EXISTING rows (Stripe→Cash targeting, supersede sets, successor
 * activation, reconciliation grouping) are ALWAYS snapshot/family-scoped — turning the
 * gate off after dual memberships exist must freeze new stacks without ever mis-scoping
 * a live member's siblings. For all-'CORE' data (pre-rollout), family scoping is provably
 * identical to the legacy single-membership semantics: any two CORE rows conflict.
 */

export const CORE_EXCLUSIVE_GROUP = 'CORE';

/**
 * The creation gate: may a NEW compatible simultaneous membership be created right now?
 * Read at call time (validateEnv normalizes MULTI_MEMBERSHIP_ENABLED to 'true'/'false').
 * This gate NEVER changes how existing memberships are scoped or related.
 */
export function allowNewMembershipStacks(): boolean {
  return process.env['MULTI_MEMBERSHIP_ENABLED'] === 'true';
}

export type CompatibilityTargetPlan = {
  id: string;
  exclusiveGroup: string | null;
};

export type CompatibilityExistingMembership = {
  membershipPlanId: string;
  /** Purchase-time snapshot from the subscription row. Null = sold as stackable. */
  exclusiveGroupKey: string | null;
};

/** Family relationship between an existing row and a target plan. ALWAYS snapshot-scoped —
 *  never gated. Use for every scoping/mutation decision about existing memberships. */
export function isConflictingMembership(
  existing: CompatibilityExistingMembership,
  targetPlan: CompatibilityTargetPlan,
): boolean {
  if (existing.membershipPlanId === targetPlan.id) {
    return true;
  }
  return (
    existing.exclusiveGroupKey !== null &&
    targetPlan.exclusiveGroup !== null &&
    existing.exclusiveGroupKey === targetPlan.exclusiveGroup
  );
}

/** Family-scoped filter over existing rows. ALWAYS snapshot-scoped — never gated. */
export function findConflictingMemberships<T extends CompatibilityExistingMembership>(
  existing: readonly T[],
  targetPlan: CompatibilityTargetPlan,
): T[] {
  return existing.filter((row) => isConflictingMembership(row, targetPlan));
}

/**
 * Creation-acceptance filter: the rows that block CREATING a membership of `targetPlan`.
 * With stacking allowed this is exactly the family conflicts; with stacking disabled,
 * EVERY existing row blocks creation (legacy single-membership acceptance). Use ONLY at
 * sites deciding whether a new row may come into existence (checkout, purchase routing,
 * webhook new-row acceptance, cash-sale acceptance, manual creation) — never for scoping.
 */
export function findCreationConflicts<T extends CompatibilityExistingMembership>(
  existing: readonly T[],
  targetPlan: CompatibilityTargetPlan,
  allowStacks: boolean = allowNewMembershipStacks(),
): T[] {
  if (!allowStacks) {
    return [...existing];
  }
  return findConflictingMemberships(existing, targetPlan);
}

export type PrimaryMembershipCandidate = {
  id: string;
  exclusiveGroupKey: string | null;
  createdAt: Date;
};

/**
 * Canonical PRIMARY membership for singular API fields (activeSubscription /
 * currentMembership): the entitled CORE-group membership first, otherwise the
 * deterministic newest entitled membership. Callers pass ONLY entitled rows.
 */
export function selectPrimaryMembership<T extends PrimaryMembershipCandidate>(
  entitled: readonly T[],
): T | null {
  if (entitled.length === 0) return null;
  const ordered = [...entitled].sort((a, b) => {
    const aCore = a.exclusiveGroupKey === CORE_EXCLUSIVE_GROUP ? 0 : 1;
    const bCore = b.exclusiveGroupKey === CORE_EXCLUSIVE_GROUP ? 0 : 1;
    if (aCore !== bCore) return aCore - bCore;
    const byNewest = b.createdAt.getTime() - a.createdAt.getTime();
    if (byNewest !== 0) return byNewest;
    return a.id.localeCompare(b.id);
  });
  return ordered[0]!;
}

export type EntitlementCandidate = {
  id: string;
  createdAt: Date;
  currentPeriodEnd: Date | null;
  entitlementEndsAt: Date | null;
  membershipPlan: { classCredits: number | null };
};

/**
 * Canonical precedence for choosing which qualifying membership authorizes (and is charged
 * for) a class. Callers pass ONLY memberships whose plan actually includes the class:
 *   1. Unlimited plans first (classCredits null) — never burn scarce credits when an
 *      unlimited membership already covers the class.
 *   2. Then credit-limited plans, entitlement window ending soonest first — expiring
 *      credits are use-it-or-lose-it, so they are spent before longer-lived ones.
 *   3. Stable tie-breaks: createdAt asc, then id — same inputs, same answer, always.
 * Credit AVAILABILITY is checked by the caller in this order (a candidate with exhausted
 * credits is skipped in favor of the next).
 */
export function orderEntitlementCandidates<T extends EntitlementCandidate>(
  candidates: readonly T[],
): T[] {
  const effectiveEnd = (c: T): number => {
    const end = c.entitlementEndsAt ?? c.currentPeriodEnd;
    return end ? end.getTime() : Number.MAX_SAFE_INTEGER;
  };
  return [...candidates].sort((a, b) => {
    const aUnlimited = a.membershipPlan.classCredits === null ? 0 : 1;
    const bUnlimited = b.membershipPlan.classCredits === null ? 0 : 1;
    if (aUnlimited !== bUnlimited) return aUnlimited - bUnlimited;
    if (aUnlimited === 1) {
      const byEnd = effectiveEnd(a) - effectiveEnd(b);
      if (byEnd !== 0) return byEnd;
    }
    const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreated !== 0) return byCreated;
    return a.id.localeCompare(b.id);
  });
}
