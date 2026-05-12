import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MembershipPlan, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateMembershipPlanDto } from './dto/create-membership-plan.dto';
import type { UpdateMembershipPlanDto } from './dto/update-membership-plan.dto';

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
