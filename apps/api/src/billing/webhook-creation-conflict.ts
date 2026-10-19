import { SubscriptionEndReason, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { deriveMembershipLifecycle } from '../memberships/membership-entitlement';

/**
 * What a webhook does when a NEW Stripe subscription arrives while the member already holds
 * renewable rows that the creation-acceptance gate treats as conflicts.
 *
 *  - An OFFLINE row (cash/manual, no Stripe id) whose access window has ENDED is not a live
 *    membership: its `status` is still ACTIVE only because nothing expires offline rows. If it is
 *    in the same family as the incoming plan (same plan, or same exclusive group) it occupies the
 *    partial unique indexes and must be superseded BEFORE the Stripe row is inserted.
 *  - An expired offline row of ANOTHER family cannot collide with any index and is left untouched.
 *  - Any other conflict (Stripe-backed, or an offline row still inside its paid window, or one
 *    whose state is not plainly expired) is live: never mutated, acknowledged for an operator.
 */
export type CreationConflictRow = {
  id: string;
  source: SubscriptionSource;
  status: SubscriptionStatus;
  stripeSubscriptionId: string | null;
  membershipPlanId: string;
  exclusiveGroupKey: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  entitlementEndsAt: Date | null;
};

export type CreationConflictDecision<T extends CreationConflictRow> =
  | { action: 'acknowledge'; blockingRow: T; conflictKind: 'stripe_backed_conflict' | 'active_cash_conflict' }
  | { action: 'supersede_then_create'; supersede: Array<{ row: T; endReason: SubscriptionEndReason }> };

export function isExpiredOfflineRow(row: CreationConflictRow, now: Date): boolean {
  return (
    row.source !== SubscriptionSource.STRIPE &&
    row.stripeSubscriptionId === null &&
    deriveMembershipLifecycle(row, now).accessState === 'EXPIRED'
  );
}

export function decideWebhookCreationConflict<T extends CreationConflictRow>(
  conflicts: readonly T[],
  target: { id: string; exclusiveGroup: string | null },
  now: Date,
): CreationConflictDecision<T> {
  const live = conflicts.find((row) => !isExpiredOfflineRow(row, now));
  if (live) {
    return {
      action: 'acknowledge',
      blockingRow: live,
      conflictKind: live.stripeSubscriptionId !== null ? 'stripe_backed_conflict' : 'active_cash_conflict',
    };
  }
  const sameFamily = (row: T) =>
    row.membershipPlanId === target.id ||
    (row.exclusiveGroupKey !== null && row.exclusiveGroupKey === target.exclusiveGroup);
  return {
    action: 'supersede_then_create',
    supersede: conflicts.filter(sameFamily).map((row) => ({
      row,
      endReason:
        row.membershipPlanId === target.id
          ? SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD
          : SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE,
    })),
  };
}
