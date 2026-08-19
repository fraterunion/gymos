import { Injectable } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipPlansService } from '../membership-plans/membership-plans.service';
import { deriveMembershipLifecycle } from './membership-entitlement';

export type MembershipsOverview = {
  totalActivePlans: number;
  totalActiveSubscribers: number;
  totalMrrCents: number;
  byStatus: Record<string, number>;
};

export type SubscriptionListItem = {
  id: string;
  status: string;
  accessState: string;
  lifecycleStatus: string;
  isEntitled: boolean;
  effectiveEnd: Date | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
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
  };
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

    const byStatus: Record<string, number> = {};
    for (const subscription of subscriptions) {
      const lifecycleStatus = deriveMembershipLifecycle(subscription, new Date()).lifecycleStatus;
      byStatus[lifecycleStatus] = (byStatus[lifecycleStatus] ?? 0) + 1;
    }

    return {
      totalActivePlans: activePlans.length,
      totalActiveSubscribers,
      totalMrrCents,
      byStatus,
    };
  }

  async listSubscriptions(
    studioId: string,
    opts: {
      status?: SubscriptionStatus;
      planId?: string;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<{ data: SubscriptionListItem[]; total: number; page: number; limit: number }> {
    const { status, planId, page = 1, limit = 50 } = opts;

    const where = {
      studioId,
      ...(status ? { status } : {}),
      ...(planId ? { membershipPlanId: planId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.subscription.findMany({
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
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.subscription.count({ where }),
    ]);

    const now = new Date();
    return {
      data: rows.map((row) => ({ ...row, ...deriveMembershipLifecycle(row, now) })) as SubscriptionListItem[],
      total,
      page,
      limit,
    };
  }
}
