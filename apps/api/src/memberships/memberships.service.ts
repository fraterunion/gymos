import { Injectable } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipPlansService } from '../membership-plans/membership-plans.service';

export type MembershipsOverview = {
  totalActivePlans: number;
  totalActiveSubscribers: number;
  totalMrrCents: number;
  byStatus: Record<string, number>;
};

export type SubscriptionListItem = {
  id: string;
  status: string;
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
    const [plans, statusGroups] = await Promise.all([
      this.plansService.listAllPlans(studioId, true),
      this.prisma.subscription.groupBy({
        by: ['status'],
        where: { studioId },
        _count: { _all: true },
      }),
    ]);

    const activePlans = plans.filter((p) => p.active && !p.deletedAt);
    const totalActiveSubscribers = activePlans.reduce((sum, p) => sum + p.activeSubscriberCount, 0);
    const totalMrrCents = activePlans.reduce((sum, p) => sum + p.mrrCents, 0);

    const byStatus: Record<string, number> = {};
    for (const g of statusGroups) {
      byStatus[g.status] = g._count._all;
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

    return { data: rows as SubscriptionListItem[], total, page, limit };
  }
}
