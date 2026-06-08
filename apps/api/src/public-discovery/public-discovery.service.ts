import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduleService } from '../schedule/schedule.service';
import type { ScheduleQueryDto } from '../schedule/dto/schedule-query.dto';

export type PublicStudioInfoDto = {
  id: string;
  name: string;
  timezone: string;
};

const publicPlanSelect = {
  id: true,
  name: true,
  description: true,
  priceCents: true,
  currency: true,
  billingInterval: true,
  classCredits: true,
  allowedCategories: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MembershipPlanSelect;

export type PublicMembershipPlanDto = Prisma.MembershipPlanGetPayload<{
  select: typeof publicPlanSelect;
}>;

@Injectable()
export class PublicDiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduleService: ScheduleService,
  ) {}

  async getStudioBySlug(slug: string): Promise<PublicStudioInfoDto> {
    const studio = await this.prisma.studio.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true, name: true, timezone: true },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }
    return studio;
  }

  async getPublicSchedule(slug: string, query: ScheduleQueryDto) {
    const { id: studioId } = await this.getStudioBySlug(slug);
    return this.scheduleService.listPublicSchedule(studioId, query);
  }

  async getPublicMembershipPlans(slug: string): Promise<PublicMembershipPlanDto[]> {
    const { id: studioId } = await this.getStudioBySlug(slug);
    return this.prisma.membershipPlan.findMany({
      where: { studioId, active: true, deletedAt: null },
      select: publicPlanSelect,
      orderBy: { createdAt: 'asc' },
    });
  }
}
