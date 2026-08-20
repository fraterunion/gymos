import { Injectable } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipPlansService } from '../membership-plans/membership-plans.service';
import { type MembershipLifecycleSnapshot } from './membership-entitlement';
import {
  groupSubscriptionsByUserId,
  loadLegacyInferenceContextForUsers,
  projectMembershipLifecycle,
  toSubscriptionSibling,
  type MembershipTransitionDetail,
} from './membership-transition';
import { toPrimaryMembershipStatus } from '../members/member-operations';
import { isCurrentImmutableCycle } from '../members/member-360.utils';

export type MembershipsOverview = {
  totalActivePlans: number;
  totalActiveSubscribers: number;
  totalMrrCents: number;
  expiringWithin7Days: number;
  requiringAttentionSubscriptions: number;
  byStatus: Record<string, number>;
};

export type SubscriptionListItem = {
  id: string;
  status: string;
  accessState: string;
  lifecycleStatus: string;
  primaryStatus: string;
  isEntitled: boolean;
  effectiveEnd: Date | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  source: string;
  createdAt: Date;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  membershipPlan: {
    id: string;
    name: string;
    billingInterval: string;
    priceCents: number;
    currency: string;
    classCredits: number | null;
    entitlementDays: number | null;
  };
  endReason: string | null;
  transitionDetail: MembershipTransitionDetail | null;
};

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plansService: MembershipPlansService,
  ) {}

  async getOverview(studioId: string): Promise<MembershipsOverview> {
    const [plans, subscriptions] = await Promise.all([
      this.plansService.listAllPlans(studioId, true),
      this.prisma.subscription.findMany({ where: { studioId } }),
    ]);

    const activePlans = plans.filter((p) => p.active && !p.deletedAt);
    const totalActiveSubscribers = activePlans.reduce((sum, p) => sum + p.activeSubscriberCount, 0);
    const totalMrrCents = activePlans.reduce((sum, p) => sum + p.mrrCents, 0);

    const now = new Date();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const sevenDaysFromNow = new Date(now.getTime() + sevenDaysMs);

    const byUser = groupSubscriptionsByUserId(subscriptions);
    const legacyContext = await loadLegacyInferenceContextForUsers(
      this.prisma,
      studioId,
      [...byUser.keys()],
    );
    const byStatus: Record<string, number> = {};
    let expiringWithin7Days = 0;
    let requiringAttentionSubscriptions = 0;
    for (const subscription of subscriptions) {
      const siblings = (byUser.get(subscription.userId) ?? [])
        .filter((s) => s.id !== subscription.id)
        .map(toSubscriptionSibling);
      const lifecycle = projectMembershipLifecycle(subscription, now, siblings, legacyContext);
      byStatus[lifecycle.lifecycleStatus] = (byStatus[lifecycle.lifecycleStatus] ?? 0) + 1;

      if (isSubscriptionRequiringAttention(lifecycle)) {
        requiringAttentionSubscriptions += 1;
      }

      if (isSubscriptionExpiringWithin7Days(lifecycle, now, sevenDaysFromNow)) {
        expiringWithin7Days += 1;
      }
    }

    return {
      totalActivePlans: activePlans.length,
      totalActiveSubscribers,
      totalMrrCents,
      expiringWithin7Days,
      requiringAttentionSubscriptions,
      byStatus,
    };
  }

  async listSubscriptions(
    studioId: string,
    opts: {
      status?: SubscriptionStatus;
      planId?: string;
      attention?: boolean;
      expiringWithin7Days?: boolean;
      search?: string;
      sort?: SubscriptionSort;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<{ data: SubscriptionListItem[]; total: number; page: number; limit: number }> {
    const { status, planId, attention, expiringWithin7Days, search, sort, page = 1, limit = 50 } = opts;
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const where = {
      studioId,
      ...(status ? { status } : {}),
      ...(planId ? { membershipPlanId: planId } : {}),
    };

    const rows = await this.prisma.subscription.findMany({
      where,
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        membershipPlan: {
          select: {
            id: true,
            name: true,
            billingInterval: true,
            priceCents: true,
            currency: true,
            classCredits: true,
            entitlementDays: true,
          },
        },
        entitlementCycles: {
          select: { startsAt: true, endsAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const byUser = groupSubscriptionsByUserId(rows);
    const legacyContext = await loadLegacyInferenceContextForUsers(
      this.prisma,
      studioId,
      [...byUser.keys()],
    );

    let mapped = rows.map((row) => {
      const siblings = (byUser.get(row.userId) ?? [])
        .filter((s) => s.id !== row.id)
        .map(toSubscriptionSibling);
      const lifecycle = projectMembershipLifecycle(
        { ...row, membershipPlan: row.membershipPlan },
        now,
        siblings,
        legacyContext,
      );
      return {
        row,
        lifecycle,
        item: {
          ...row,
          ...lifecycle,
          primaryStatus: toPrimaryMembershipStatus(lifecycle.lifecycleStatus, {
            isEntitled: lifecycle.isEntitled,
            hasCurrentPaidEntitlementCycle: row.entitlementCycles.some((cycle) =>
              isCurrentImmutableCycle(cycle, now),
            ),
          }),
          endReason: lifecycle.endReason,
          transitionDetail: lifecycle.transitionDetail,
        } as SubscriptionListItem,
      };
    });

    if (status === SubscriptionStatus.CANCELED) {
      mapped = mapped.filter(({ lifecycle }) => lifecycle.lifecycleStatus === 'CANCELED');
    }

    if (attention) {
      mapped = mapped.filter(({ lifecycle }) => isSubscriptionRequiringAttention(lifecycle));
    }
    if (expiringWithin7Days) {
      mapped = mapped.filter(({ lifecycle }) =>
        isSubscriptionExpiringWithin7Days(lifecycle, now, sevenDaysFromNow),
      );
    }
    if (search?.trim()) {
      mapped = mapped.filter(({ row }) => subscriptionMatchesSearch(row.user, search));
    }
    if (sort) {
      mapped = sortSubscriptionRows(mapped, sort);
    }

    const total = mapped.length;
    const start = (page - 1) * limit;
    const pageRows = mapped.slice(start, start + limit);

    return {
      data: pageRows.map(({ item }) => item),
      total,
      page,
      limit,
    };
  }
}

export type SubscriptionSort = 'effective_end_asc' | 'effective_end_desc';

type SubscriptionUser = {
  firstName: string;
  lastName: string;
  email: string;
};

export function subscriptionMatchesSearch(user: SubscriptionUser, rawSearch: string): boolean {
  const term = rawSearch.trim().toLowerCase();
  if (!term) return true;
  const haystack = [
    user.firstName,
    user.lastName,
    user.email,
    `${user.firstName} ${user.lastName}`,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(term);
}

const HISTORICAL_LIFECYCLE_STATUSES = new Set<MembershipLifecycleSnapshot['lifecycleStatus']>([
  'REPLACED',
  'EXPIRED',
  'CANCELED',
]);

/** Historical ended records — not current/upcoming operational subscriptions. */
export function isHistoricalSubscriptionLifecycle(
  lifecycle: MembershipLifecycleSnapshot,
): boolean {
  return HISTORICAL_LIFECYCLE_STATUSES.has(lifecycle.lifecycleStatus);
}

export function effectiveEndSortKey(lifecycle: MembershipLifecycleSnapshot): number {
  return lifecycle.effectiveEnd?.getTime() ?? Number.MAX_SAFE_INTEGER;
}

function effectiveEndTimestamp(lifecycle: MembershipLifecycleSnapshot): number | null {
  return lifecycle.effectiveEnd?.getTime() ?? null;
}

export function compareSubscriptionsByEffectiveEnd(
  a: MembershipLifecycleSnapshot,
  b: MembershipLifecycleSnapshot,
  sort: SubscriptionSort,
): number {
  const aHistorical = isHistoricalSubscriptionLifecycle(a);
  const bHistorical = isHistoricalSubscriptionLifecycle(b);

  if (aHistorical !== bHistorical) {
    return aHistorical ? 1 : -1;
  }

  const aTs = effectiveEndTimestamp(a);
  const bTs = effectiveEndTimestamp(b);

  if (aTs === null && bTs === null) return 0;
  if (aTs === null) return 1;
  if (bTs === null) return -1;

  if (aHistorical) {
    return bTs - aTs;
  }

  return sort === 'effective_end_asc' ? aTs - bTs : bTs - aTs;
}

export function sortSubscriptionRows<T extends { lifecycle: MembershipLifecycleSnapshot }>(
  rows: T[],
  sort: SubscriptionSort,
): T[] {
  return [...rows].sort((a, b) =>
    compareSubscriptionsByEffectiveEnd(a.lifecycle, b.lifecycle, sort),
  );
}

const ATTENTION_LIFECYCLE_STATUSES = new Set(['PAST_DUE', 'PAUSED', 'EXPIRED']);

export function isSubscriptionRequiringAttention(lifecycle: MembershipLifecycleSnapshot): boolean {
  return ATTENTION_LIFECYCLE_STATUSES.has(lifecycle.lifecycleStatus);
}

/** UTC instant comparison — same semantics as overview KPI. */
export function isSubscriptionExpiringWithin7Days(
  lifecycle: MembershipLifecycleSnapshot,
  now: Date,
  sevenDaysFromNow: Date,
): boolean {
  return (
    lifecycle.isEntitled &&
    lifecycle.effectiveEnd !== null &&
    lifecycle.effectiveEnd.getTime() > now.getTime() &&
    lifecycle.effectiveEnd.getTime() <= sevenDaysFromNow.getTime()
  );
}
