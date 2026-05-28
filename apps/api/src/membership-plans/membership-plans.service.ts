import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MembershipPlan, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateMembershipPlanDto } from './dto/create-membership-plan.dto';
import type { UpdateMembershipPlanDto } from './dto/update-membership-plan.dto';

export type MembershipPlanWithStats = MembershipPlan & {
  activeSubscriberCount: number;
  mrrCents: number;
};

function computeMrr(priceCents: number, interval: string, count: number): number {
  if (count === 0) return 0;
  if (interval === 'MONTHLY') return priceCents * count;
  if (interval === 'YEARLY') return Math.round((priceCents / 12) * count);
  if (interval === 'WEEKLY') return Math.round((priceCents * 52) / 12 * count);
  return 0;
}

@Injectable()
export class MembershipPlansService {
  constructor(private readonly prisma: PrismaService) {}

  async listActivePlans(studioId: string): Promise<MembershipPlan[]> {
    return this.prisma.membershipPlan.findMany({
      where: {
        studioId,
        deletedAt: null,
        active: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async listAllPlans(
    studioId: string,
    includeInactive = false,
  ): Promise<MembershipPlanWithStats[]> {
    const where: Prisma.MembershipPlanWhereInput = {
      studioId,
      deletedAt: null,
      ...(includeInactive ? {} : { active: true }),
    };

    const plans = await this.prisma.membershipPlan.findMany({
      where,
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
      include: {
        _count: {
          select: {
            subscriptions: {
              where: { status: { in: ['ACTIVE', 'TRIALING', 'PAUSED'] } },
            },
          },
        },
      },
    });

    return plans.map((p) => {
      const { _count, ...plan } = p;
      const count = _count.subscriptions;
      return {
        ...plan,
        activeSubscriberCount: count,
        mrrCents: computeMrr(plan.priceCents, plan.billingInterval, count),
      };
    });
  }

  async createPlan(studioId: string, dto: CreateMembershipPlanDto): Promise<MembershipPlan> {
    await this.ensureStudioExists(studioId);
    return this.prisma.membershipPlan.create({
      data: {
        studioId,
        name: dto.name,
        description: dto.description ?? null,
        priceCents: dto.priceCents,
        currency: dto.currency ?? 'usd',
        billingInterval: dto.billingInterval,
        classCredits: dto.classCredits === undefined ? null : dto.classCredits,
        stripeProductId: dto.stripeProductId ?? null,
        stripePriceId: dto.stripePriceId ?? null,
        active: true,
      },
    });
  }

  async updatePlan(
    studioId: string,
    planId: string,
    dto: UpdateMembershipPlanDto,
  ): Promise<MembershipPlan> {
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: planId, studioId, deletedAt: null },
    });
    if (!plan) {
      throw new NotFoundException('Membership plan not found');
    }
    const data: Prisma.MembershipPlanUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.priceCents !== undefined ? { priceCents: dto.priceCents } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
      ...(dto.billingInterval !== undefined ? { billingInterval: dto.billingInterval } : {}),
      ...(dto.classCredits !== undefined ? { classCredits: dto.classCredits } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
      ...(dto.stripeProductId !== undefined ? { stripeProductId: dto.stripeProductId } : {}),
      ...(dto.stripePriceId !== undefined ? { stripePriceId: dto.stripePriceId } : {}),
    };
    if (Object.keys(data).length === 0) {
      return plan;
    }
    return this.prisma.membershipPlan.update({
      where: { id: planId },
      data,
    });
  }

  async softDeletePlan(studioId: string, planId: string): Promise<void> {
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: planId, studioId, deletedAt: null },
    });
    if (!plan) {
      throw new NotFoundException('Membership plan not found');
    }
    await this.prisma.membershipPlan.update({
      where: { id: planId },
      data: {
        deletedAt: new Date(),
        active: false,
      },
    });
  }

  private async ensureStudioExists(studioId: string): Promise<void> {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }
  }
}
