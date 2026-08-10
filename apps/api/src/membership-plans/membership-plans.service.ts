import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MembershipPlan, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateMembershipPlanDto } from './dto/create-membership-plan.dto';
import type { UpdateMembershipPlanDto } from './dto/update-membership-plan.dto';
import {
  buildPlanClassAccessDto,
  dedupeTemplateIds,
  type PlanClassAccessDto,
  validateRestrictedPlanAccess,
} from './membership-plan-class-access.utils';

export type MembershipPlanWithStats = MembershipPlan & {
  activeSubscriberCount: number;
  mrrCents: number;
  classAccess: PlanClassAccessDto;
};

const classAccessInclude = {
  classTemplateAccess: {
    include: {
      classTemplate: {
        select: {
          id: true,
          name: true,
          durationMinutes: true,
          deletedAt: true,
        },
      },
    },
    orderBy: { classTemplate: { name: 'asc' as const } },
  },
} satisfies Prisma.MembershipPlanInclude;

type PlanWithAccess = Prisma.MembershipPlanGetPayload<{
  include: typeof classAccessInclude;
}>;

function computeMrr(priceCents: number, interval: string, count: number): number {
  if (count === 0) return 0;
  if (interval === 'MONTHLY') return priceCents * count;
  if (interval === 'YEARLY') return Math.round((priceCents / 12) * count);
  if (interval === 'WEEKLY') return Math.round((priceCents * 52) / 12 * count);
  return 0;
}

function mapPlanWithClassAccess(plan: PlanWithAccess): MembershipPlan & { classAccess: PlanClassAccessDto } {
  const { classTemplateAccess, ...rest } = plan;
  return {
    ...rest,
    classAccess: buildPlanClassAccessDto({
      allClassesAccess: plan.allClassesAccess,
      templates: classTemplateAccess.map((row) => row.classTemplate),
    }),
  };
}

@Injectable()
export class MembershipPlansService {
  constructor(private readonly prisma: PrismaService) {}

  async listActivePlans(studioId: string): Promise<Array<MembershipPlan & { classAccess: PlanClassAccessDto }>> {
    const plans = await this.prisma.membershipPlan.findMany({
      where: {
        studioId,
        deletedAt: null,
        active: true,
      },
      orderBy: { createdAt: 'asc' },
      include: classAccessInclude,
    });
    return plans.map(mapPlanWithClassAccess);
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
        ...classAccessInclude,
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
      const mapped = mapPlanWithClassAccess(plan);
      const count = _count.subscriptions;
      return {
        ...mapped,
        activeSubscriberCount: count,
        mrrCents: computeMrr(mapped.priceCents, mapped.billingInterval, count),
      };
    });
  }

  async createPlan(
    studioId: string,
    dto: CreateMembershipPlanDto,
  ): Promise<MembershipPlan & { classAccess: PlanClassAccessDto }> {
    await this.ensureStudioExists(studioId);

    const allClassesAccess = dto.allClassesAccess ?? true;
    const classTemplateIds = dedupeTemplateIds(dto.classTemplateIds);
    this.assertNoDuplicateTemplateIds(dto.classTemplateIds, classTemplateIds);
    this.assertRestrictedAccess(allClassesAccess, classTemplateIds, dto.allowedCategories ?? []);
    await this.validateClassTemplateIds(studioId, classTemplateIds);

    const plan = await this.prisma.$transaction(async (tx) => {
      const created = await tx.membershipPlan.create({
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
          allowedCategories: dto.allowedCategories ?? [],
          allClassesAccess,
          active: true,
        },
      });

      if (!allClassesAccess && classTemplateIds.length > 0) {
        await tx.membershipPlanClassAccess.createMany({
          data: classTemplateIds.map((classTemplateId) => ({
            studioId,
            membershipPlanId: created.id,
            classTemplateId,
          })),
        });
      }

      return tx.membershipPlan.findUniqueOrThrow({
        where: { id: created.id },
        include: classAccessInclude,
      });
    });

    return mapPlanWithClassAccess(plan);
  }

  async updatePlan(
    studioId: string,
    planId: string,
    dto: UpdateMembershipPlanDto,
  ): Promise<MembershipPlan & { classAccess: PlanClassAccessDto }> {
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: planId, studioId, deletedAt: null },
      include: classAccessInclude,
    });
    if (!plan) {
      throw new NotFoundException('Membership plan not found');
    }

    const nextAllClassesAccess = dto.allClassesAccess ?? plan.allClassesAccess;
    const classTemplateIdsProvided = dto.classTemplateIds !== undefined;
    const classTemplateIds = classTemplateIdsProvided
      ? dedupeTemplateIds(dto.classTemplateIds)
      : plan.classTemplateAccess.map((row) => row.classTemplateId);

    if (classTemplateIdsProvided) {
      this.assertNoDuplicateTemplateIds(dto.classTemplateIds, classTemplateIds);
    }

    const nextAllowedCategories =
      dto.allowedCategories !== undefined ? dto.allowedCategories : plan.allowedCategories;

    if (dto.allClassesAccess !== undefined || classTemplateIdsProvided) {
      this.assertRestrictedAccess(nextAllClassesAccess, classTemplateIds, nextAllowedCategories);
      await this.validateClassTemplateIds(studioId, classTemplateIds);
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
      ...(dto.allowedCategories !== undefined ? { allowedCategories: dto.allowedCategories } : {}),
      ...(dto.allClassesAccess !== undefined ? { allClassesAccess: dto.allClassesAccess } : {}),
    };

    const accessChanged =
      dto.allClassesAccess !== undefined || classTemplateIdsProvided;

    if (Object.keys(data).length === 0 && !accessChanged) {
      return mapPlanWithClassAccess(plan);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.membershipPlan.update({
          where: { id: planId },
          data,
        });
      }

      if (accessChanged) {
        await tx.membershipPlanClassAccess.deleteMany({
          where: { membershipPlanId: planId },
        });

        if (!nextAllClassesAccess && classTemplateIds.length > 0) {
          await tx.membershipPlanClassAccess.createMany({
            data: classTemplateIds.map((classTemplateId) => ({
              studioId,
              membershipPlanId: planId,
              classTemplateId,
            })),
          });
        }
      }

      return tx.membershipPlan.findUniqueOrThrow({
        where: { id: planId },
        include: classAccessInclude,
      });
    });

    return mapPlanWithClassAccess(updated);
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

  private assertRestrictedAccess(
    allClassesAccess: boolean,
    classTemplateIds: string[],
    allowedCategories: MembershipPlan['allowedCategories'],
  ): void {
    try {
      validateRestrictedPlanAccess({
        allClassesAccess,
        classTemplateIds,
        allowedCategories,
      });
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Invalid class access configuration.',
      );
    }
  }

  private assertNoDuplicateTemplateIds(
    raw: string[] | undefined,
    deduped: string[],
  ): void {
    if (!raw?.length) return;
    if (raw.length !== deduped.length) {
      throw new BadRequestException('Duplicate class template IDs are not allowed.');
    }
  }

  private async validateClassTemplateIds(
    studioId: string,
    classTemplateIds: string[],
  ): Promise<void> {
    if (classTemplateIds.length === 0) return;

    const templates = await this.prisma.classTemplate.findMany({
      where: {
        id: { in: classTemplateIds },
        studioId,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (templates.length !== classTemplateIds.length) {
      throw new BadRequestException(
        'One or more class templates were not found in this studio.',
      );
    }
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
