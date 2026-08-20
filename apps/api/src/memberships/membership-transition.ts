import {
  SubscriptionEndReason,
  SubscriptionSource,
  SubscriptionStatus,
} from '@prisma/client';
import {
  deriveMembershipLifecycle,
  type MembershipLifecycleSnapshot,
  type MembershipLifecycleStatus,
} from './membership-entitlement';

/** Max elapsed time between superseded-row update and successor creation in one operation. */
export const OPERATIONAL_SUPERSESSION_CLUSTER_MS = 5 * 60 * 1000;

export type SubscriptionSibling = {
  id: string;
  membershipPlanId: string;
  source: SubscriptionSource;
  status: SubscriptionStatus;
  stripeSubscriptionId?: string | null;
  createdAt: Date;
  updatedAt?: Date;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
};

export type SubscriptionTransitionInput = {
  id: string;
  status: SubscriptionStatus;
  source: SubscriptionSource;
  membershipPlanId: string;
  stripeSubscriptionId?: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  entitlementEndsAt: Date | null;
  cancelAtPeriodEnd?: boolean;
  endReason?: SubscriptionEndReason | null;
  supersededBySubscriptionId?: string | null;
  createdAt: Date;
  updatedAt?: Date;
  membershipPlan?: { name: string };
};

export type LegacyPlanChangeAudit = {
  previousPlanId: string;
  newPlanId: string;
  createdAt: Date;
};

/** Deterministic evidence loaded from audit logs — never inferred from timing alone. */
export type LegacyInferenceContext = {
  cashCreatedSubscriptionIds: ReadonlySet<string>;
  planChanges: readonly LegacyPlanChangeAudit[];
};

export const EMPTY_LEGACY_INFERENCE_CONTEXT: LegacyInferenceContext = {
  cashCreatedSubscriptionIds: new Set(),
  planChanges: [],
};

export type MembershipTransitionDetail = {
  label: string;
  detail: string;
};

export type ProjectedMembershipLifecycle = MembershipLifecycleSnapshot & {
  lifecycleStatus: MembershipLifecycleStatus;
  endReason: SubscriptionEndReason | null;
  transitionDetail: MembershipTransitionDetail | null;
};

const RENEWABLE_SUCCESSOR_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.PAUSED,
];

export function isSupersededEndReason(
  reason: SubscriptionEndReason | null | undefined,
): boolean {
  return (
    reason === SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD ||
    reason === SubscriptionEndReason.SUPERSEDED_RENEWAL ||
    reason === SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE
  );
}

export function buildLegacyInferenceContext(
  audits: Array<{
    action: string;
    entityId: string | null;
    metadata: unknown;
    createdAt: Date;
  }>,
): LegacyInferenceContext {
  const cashCreatedSubscriptionIds = new Set<string>();
  const planChanges: LegacyPlanChangeAudit[] = [];

  for (const audit of audits) {
    if (audit.action === 'CASH_SUBSCRIPTION_CREATED' && audit.entityId) {
      cashCreatedSubscriptionIds.add(audit.entityId);
    }
    if (audit.action === 'MEMBERSHIP_PLAN_CHANGED') {
      const metadata = audit.metadata as Record<string, unknown> | null;
      const previousPlanId = metadata?.previousPlanId;
      const newPlanId = metadata?.newPlanId;
      if (typeof previousPlanId === 'string' && typeof newPlanId === 'string') {
        planChanges.push({ previousPlanId, newPlanId, createdAt: audit.createdAt });
      }
    }
  }

  return { cashCreatedSubscriptionIds, planChanges };
}

export function isOperationalSupersessionCluster(
  supersededUpdatedAt: Date | undefined,
  successorCreatedAt: Date,
  clusterMs: number = OPERATIONAL_SUPERSESSION_CLUSTER_MS,
): boolean {
  if (!supersededUpdatedAt) return false;
  return Math.abs(successorCreatedAt.getTime() - supersededUpdatedAt.getTime()) <= clusterMs;
}

function isRenewableSuccessor(sibling: SubscriptionSibling): boolean {
  return (
    RENEWABLE_SUCCESSOR_STATUSES.includes(sibling.status) &&
    sibling.id !== undefined
  );
}

function inferLegacyReasonForSuccessor(
  subscription: SubscriptionTransitionInput,
  successor: SubscriptionSibling,
  context: LegacyInferenceContext,
): SubscriptionEndReason | null {
  if (subscription.status !== SubscriptionStatus.CANCELED) return null;
  if (subscription.endReason) return null;

  const cluster = isOperationalSupersessionCluster(subscription.updatedAt, successor.createdAt);
  if (!cluster) return null;

  const samePlan = subscription.membershipPlanId === successor.membershipPlanId;

  // Luis pattern: sales.service.createOfflineSubscription — audit on successor row.
  if (
    samePlan &&
    subscription.source === SubscriptionSource.CASH &&
    successor.source === SubscriptionSource.CASH &&
    context.cashCreatedSubscriptionIds.has(successor.id)
  ) {
    return SubscriptionEndReason.SUPERSEDED_RENEWAL;
  }

  // Carlo pattern: webhook handleWebhookActiveConflict — expired CASH superseded by Stripe sub.
  if (
    samePlan &&
    subscription.source === SubscriptionSource.CASH &&
    !subscription.stripeSubscriptionId &&
    successor.source === SubscriptionSource.STRIPE &&
    Boolean(successor.stripeSubscriptionId)
  ) {
    return SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD;
  }

  // STRIPE → CASH: offline assignment after cancel_immediately on Stripe row.
  if (
    samePlan &&
    subscription.source === SubscriptionSource.STRIPE &&
    Boolean(subscription.stripeSubscriptionId) &&
    successor.source === SubscriptionSource.CASH &&
    context.cashCreatedSubscriptionIds.has(successor.id)
  ) {
    return SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD;
  }

  // Plan change: requires explicit MEMBERSHIP_PLAN_CHANGED audit — never sibling/timing alone.
  if (!samePlan) {
    const linkedPlanChange = context.planChanges.find(
      (change) =>
        change.previousPlanId === subscription.membershipPlanId &&
        change.newPlanId === successor.membershipPlanId &&
        isOperationalSupersessionCluster(change.createdAt, successor.createdAt),
    );
    if (linkedPlanChange) {
      return SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE;
    }
  }

  return null;
}

/** Conservative legacy inference — requires deterministic audit/structural evidence. */
export function inferLegacySupersessionReason(
  subscription: SubscriptionTransitionInput,
  siblings: SubscriptionSibling[],
  context: LegacyInferenceContext = EMPTY_LEGACY_INFERENCE_CONTEXT,
): SubscriptionEndReason | null {
  if (subscription.status !== SubscriptionStatus.CANCELED) return null;
  if (subscription.endReason) return null;

  const successors = siblings
    .filter(
      (s) =>
        s.id !== subscription.id &&
        s.createdAt > subscription.createdAt &&
        isRenewableSuccessor(s),
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const successor of successors) {
    const reason = inferLegacyReasonForSuccessor(subscription, successor, context);
    if (reason) return reason;
  }

  return null;
}

export function resolveEffectiveEndReason(
  subscription: SubscriptionTransitionInput,
  siblings: SubscriptionSibling[] = [],
  context: LegacyInferenceContext = EMPTY_LEGACY_INFERENCE_CONTEXT,
): SubscriptionEndReason | null {
  if (subscription.endReason) return subscription.endReason;
  return inferLegacySupersessionReason(subscription, siblings, context);
}

function paymentSourceLabel(source: SubscriptionSource): string {
  switch (source) {
    case SubscriptionSource.STRIPE:
      return 'Stripe';
    case SubscriptionSource.CASH:
      return 'Efectivo';
    case SubscriptionSource.MANUAL:
      return 'Manual';
    default:
      return source;
  }
}

export function buildTransitionDetail(
  endReason: SubscriptionEndReason | null,
  subscription: SubscriptionTransitionInput,
  successor?: Pick<SubscriptionSibling, 'source' | 'membershipPlanId'> & {
    membershipPlan?: { name: string };
  },
): MembershipTransitionDetail | null {
  if (!isSupersededEndReason(endReason)) return null;

  switch (endReason) {
    case SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD:
      return {
        label: 'Cambio de forma de pago',
        detail: successor
          ? `${paymentSourceLabel(subscription.source)} → ${paymentSourceLabel(successor.source)}`
          : paymentSourceLabel(subscription.source),
      };
    case SubscriptionEndReason.SUPERSEDED_RENEWAL:
      return {
        label: 'Renovación',
        detail: subscription.membershipPlan?.name ?? 'Misma membresía',
      };
    case SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE:
      return {
        label: 'Cambio de plan',
        detail: successor?.membershipPlan?.name
          ? `${subscription.membershipPlan?.name ?? 'Plan anterior'} → ${successor.membershipPlan.name}`
          : (subscription.membershipPlan?.name ?? 'Plan anterior'),
      };
    default:
      return null;
  }
}

function applyReplacementLifecycle(
  snapshot: MembershipLifecycleSnapshot,
  endReason: SubscriptionEndReason | null,
): MembershipLifecycleSnapshot {
  if (endReason === SubscriptionEndReason.MEMBER_CANCELLED) return snapshot;
  if (!isSupersededEndReason(endReason)) return snapshot;
  if (snapshot.isEntitled) return snapshot;
  if (snapshot.lifecycleStatus === 'EXPIRED' || snapshot.lifecycleStatus === 'CANCELED') {
    return { ...snapshot, lifecycleStatus: 'REPLACED' };
  }
  return snapshot;
}

export function findSuccessorForTransition(
  subscription: SubscriptionTransitionInput,
  siblings: SubscriptionSibling[],
  context: LegacyInferenceContext = EMPTY_LEGACY_INFERENCE_CONTEXT,
): SubscriptionSibling | undefined {
  if (subscription.supersededBySubscriptionId) {
    return siblings.find((s) => s.id === subscription.supersededBySubscriptionId);
  }

  const successors = siblings
    .filter(
      (s) =>
        s.id !== subscription.id &&
        s.createdAt > subscription.createdAt &&
        isRenewableSuccessor(s),
    )
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const successor of successors) {
    if (inferLegacyReasonForSuccessor(subscription, successor, context)) {
      return successor;
    }
  }

  return undefined;
}

export function projectMembershipLifecycle(
  subscription: SubscriptionTransitionInput,
  now: Date,
  siblings: SubscriptionSibling[] = [],
  context: LegacyInferenceContext = EMPTY_LEGACY_INFERENCE_CONTEXT,
): ProjectedMembershipLifecycle {
  const endReason = resolveEffectiveEndReason(subscription, siblings, context);
  const base = deriveMembershipLifecycle(subscription, now);
  const lifecycle = applyReplacementLifecycle(base, endReason);
  const successor = findSuccessorForTransition(subscription, siblings, context);

  return {
    ...lifecycle,
    endReason,
    transitionDetail: buildTransitionDetail(endReason, subscription, successor),
  };
}

export function groupSubscriptionsByUserId<T extends { userId: string }>(
  subscriptions: T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const sub of subscriptions) {
    const list = map.get(sub.userId) ?? [];
    list.push(sub);
    map.set(sub.userId, list);
  }
  return map;
}

export function toSubscriptionSibling(
  row: SubscriptionTransitionInput & { userId?: string },
): SubscriptionSibling {
  return {
    id: row.id,
    membershipPlanId: row.membershipPlanId,
    source: row.source,
    status: row.status,
    stripeSubscriptionId: row.stripeSubscriptionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
  };
}

export async function loadLegacyInferenceContextForUsers(
  prisma: {
    auditLog: {
      findMany: (args: {
        where: {
          studioId: string;
          targetUserId: { in: string[] };
          action: { in: string[] };
        };
        select: { action: true; entityId: true; metadata: true; createdAt: true };
      }) => Promise<Array<{
        action: string;
        entityId: string | null;
        metadata: unknown;
        createdAt: Date;
      }>>;
    };
  },
  studioId: string,
  userIds: string[],
): Promise<LegacyInferenceContext> {
  if (userIds.length === 0) return EMPTY_LEGACY_INFERENCE_CONTEXT;

  const audits = await prisma.auditLog.findMany({
    where: {
      studioId,
      targetUserId: { in: userIds },
      action: { in: ['CASH_SUBSCRIPTION_CREATED', 'MEMBERSHIP_PLAN_CHANGED'] },
    },
    select: { action: true, entityId: true, metadata: true, createdAt: true },
  });

  return buildLegacyInferenceContext(audits);
}
