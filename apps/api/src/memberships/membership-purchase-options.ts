import { SubscriptionStatus } from '@prisma/client';
import {
  allowNewMembershipStacks,
  isConflictingMembership,
} from './membership-compatibility';

/**
 * MM-5 — the ONE server-side implementation of catalog CTA semantics. Clients render
 * `purchaseAction` verbatim and never re-derive compatibility (exclusiveGroup is never
 * exposed to them). Computed from the same canonical family logic the purchase mutations
 * use, so the advertised action and the mutation outcome cannot disagree:
 *
 *   SUBSCRIBE  member has no current membership → plain checkout
 *   CURRENT    member already holds this plan, entitled and renewing → nothing to do
 *   RENEW      member's own plan window is ending/ended (canceled-but-entitled, expired)
 *   CHANGE     a Stripe membership in the same family → plan-change semantics
 *   ADD        compatible additional membership (only while stacking is enabled)
 *   SCHEDULED  a successor for this family is already scheduled
 *   BLOCKED    no safe self-serve path (past-due, paused, cash family row that must be
 *              handled at the desk, or stacking disabled) — reasonCode says why
 */

export type PurchaseAction =
  | 'SUBSCRIBE'
  | 'CURRENT'
  | 'RENEW'
  | 'CHANGE'
  | 'ADD'
  | 'SCHEDULED'
  | 'BLOCKED';

export type PurchaseOptionReason =
  | 'PAST_DUE'
  | 'PAUSED'
  | 'IN_PERSON'
  | 'STACKING_DISABLED'
  | 'RESUBSCRIBE'
  | null;

export type PurchaseOption = {
  planId: string;
  purchaseAction: PurchaseAction;
  /** The member's own membership this action relates to (renew/change/scheduled). */
  relatedSubscriptionId: string | null;
  relatedPlanName: string | null;
  /** SCHEDULED only: when the already-scheduled successor starts. */
  effectiveDate: Date | null;
  reasonCode: PurchaseOptionReason;
};

export type PurchaseOptionPlan = {
  id: string;
  name: string;
  exclusiveGroup: string | null;
};

/**
 * Which surface is asking. Staff (desk) flows can renew/change CASH memberships via the
 * cash-sale supersede path, which self-serve checkout cannot do safely — so the same
 * state maps to different actions per surface, mirroring each surface's real mutations.
 */
export type PurchaseOptionContext = 'member' | 'staff';

export type PurchaseOptionMembershipRow = {
  id: string;
  membershipPlanId: string;
  /** Purchase-time snapshot — the only compatibility input, per membership-compatibility. */
  exclusiveGroupKey: string | null;
  status: SubscriptionStatus;
  stripeSubscriptionId: string | null;
  isEntitled: boolean;
  currentPeriodStart: Date | null;
  planName: string;
};

export function resolvePurchaseAction(
  plan: PurchaseOptionPlan,
  currentRows: readonly PurchaseOptionMembershipRow[],
  scheduledRows: readonly PurchaseOptionMembershipRow[],
  allowStacks: boolean = allowNewMembershipStacks(),
  context: PurchaseOptionContext = 'member',
): PurchaseOption {
  const base = {
    planId: plan.id,
    relatedSubscriptionId: null as string | null,
    relatedPlanName: null as string | null,
    effectiveDate: null as Date | null,
    reasonCode: null as PurchaseOptionReason,
  };

  // A successor already scheduled in this plan's family wins over everything.
  const scheduled = scheduledRows.find((row) => isConflictingMembership(row, plan));
  if (scheduled) {
    return {
      ...base,
      purchaseAction: 'SCHEDULED',
      relatedSubscriptionId: scheduled.id,
      relatedPlanName: scheduled.planName,
      effectiveDate: scheduled.currentPeriodStart,
    };
  }

  const conflicts = currentRows.filter((row) => isConflictingMembership(row, plan));
  const samePlan = conflicts.find((row) => row.membershipPlanId === plan.id);

  if (samePlan) {
    const related = {
      relatedSubscriptionId: samePlan.id,
      relatedPlanName: samePlan.planName,
    };
    if (samePlan.status === SubscriptionStatus.PAST_DUE) {
      return { ...base, ...related, purchaseAction: 'BLOCKED', reasonCode: 'PAST_DUE' };
    }
    if (samePlan.status === SubscriptionStatus.PAUSED) {
      return { ...base, ...related, purchaseAction: 'BLOCKED', reasonCode: 'PAUSED' };
    }
    if (
      samePlan.isEntitled &&
      (samePlan.status === SubscriptionStatus.ACTIVE || samePlan.status === SubscriptionStatus.TRIALING)
    ) {
      // Desk can renew a cash membership early (fixed-duration queues consecutively);
      // a Stripe membership renews itself, and self-serve same-plan has nothing to do.
      if (context === 'staff' && !samePlan.stripeSubscriptionId) {
        return { ...base, ...related, purchaseAction: 'RENEW' };
      }
      return { ...base, ...related, purchaseAction: 'CURRENT' };
    }
    // Canceled-but-entitled or lapsed: buying the same plan again is a fresh window.
    return { ...base, ...related, purchaseAction: 'RENEW', reasonCode: 'RESUBSCRIBE' };
  }

  // Prefer a Stripe-backed family membership (actionable via plan change) over a cash one.
  const familyConflict = conflicts.find((row) => row.stripeSubscriptionId) ?? conflicts[0] ?? null;
  if (familyConflict) {
    const related = {
      relatedSubscriptionId: familyConflict.id,
      relatedPlanName: familyConflict.planName,
    };
    if (familyConflict.stripeSubscriptionId || context === 'staff') {
      // Stripe rows plan-change from any surface; cash rows only via the desk's
      // cash-sale supersede flow.
      return { ...base, ...related, purchaseAction: 'CHANGE' };
    }
    // A cash/manual family membership cannot be plan-changed from self-serve checkout —
    // an online purchase would strand the payment as a Stripe orphan. Desk flow only.
    return { ...base, ...related, purchaseAction: 'BLOCKED', reasonCode: 'IN_PERSON' };
  }

  if (currentRows.length === 0) {
    return { ...base, purchaseAction: 'SUBSCRIBE' };
  }

  // Compatible additional membership — advertised only while the creation gate allows
  // new stacks, mirroring initiateMembershipPurchase's acceptance exactly.
  if (allowStacks) {
    return { ...base, purchaseAction: 'ADD' };
  }
  return { ...base, purchaseAction: 'BLOCKED', reasonCode: 'STACKING_DISABLED' };
}
