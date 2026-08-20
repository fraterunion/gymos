import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MembershipPlan, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import { buildAuditChangesRecord, toAuditMetadata } from '../sales/audit-metadata.utils';
import type { CreateMembershipPlanDto } from './dto/create-membership-plan.dto';
import type { UpdateMembershipPlanDto } from './dto/update-membership-plan.dto';
import { currentlyEntitledSubscriptionWhere } from '../memberships/membership-entitlement';
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
          isOpenGymSlot: true,
          accessWindowStart: true,
          accessWindowEnd: true,
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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
              where: currentlyEntitledSubscriptionWhere(new Date()),
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
    actorUserId?: string,
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
          entitlementDays: dto.entitlementDays === undefined ? null : dto.entitlementDays,
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

    const mapped = mapPlanWithClassAccess(plan);
    if (actorUserId) {
      await this.audit.log({
        studioId,
        actorUserId,
        action: 'MEMBERSHIP_PLAN_CREATED',
        entityType: 'membership_plan',
        entityId: mapped.id,
        metadata: {
          planName: mapped.name,
          priceCents: mapped.priceCents,
          classCredits: mapped.classCredits,
          entitlementDays: mapped.entitlementDays,
          allClassesAccess: mapped.allClassesAccess,
        },
      });
    }
    return mapped;
  }

  async updatePlan(
    studioId: string,
    planId: string,
    dto: UpdateMembershipPlanDto,
    actorUserId?: string,
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
      ...(dto.entitlementDays !== undefined ? { entitlementDays: dto.entitlementDays } : {}),
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

    const mapped = mapPlanWithClassAccess(updated);
    if (actorUserId) {
      if (accessChanged) {
        await this.logPlanClassAccessChanges(
          studioId,
          planId,
          mapped.name,
          actorUserId,
          plan,
          nextAllClassesAccess,
          classTemplateIds,
          mapped,
        );
      }
      const scalarChanges = this.diffPlanChanges(plan, mapped, dto);
      if (scalarChanges.length > 0) {
        await this.audit.log({
          studioId,
          actorUserId,
          action: 'MEMBERSHIP_PLAN_UPDATED',
          entityType: 'membership_plan',
          entityId: planId,
          metadata: toAuditMetadata({
            planName: mapped.name,
            changes: buildAuditChangesRecord(scalarChanges),
          }),
        });
      }
    }
    return mapped;
  }

  private async logPlanClassAccessChanges(
    studioId: string,
    planId: string,
    planName: string,
    actorUserId: string,
    before: PlanWithAccess,
    nextAllClassesAccess: boolean,
    nextTemplateIds: string[],
    afterMapped: MembershipPlan & { classAccess: PlanClassAccessDto },
  ): Promise<void> {
    const beforeIds = new Set(before.classTemplateAccess.map((row) => row.classTemplateId));
    const nameById = new Map(
      before.classTemplateAccess.map((row) => [row.classTemplateId, row.classTemplate.name]),
    );
    for (const template of afterMapped.classAccess.templates) {
      nameById.set(template.id, template.name);
    }

    const afterIds = nextAllClassesAccess
      ? new Set<string>()
      : new Set(nextTemplateIds);

    for (const templateId of afterIds) {
      if (!beforeIds.has(templateId)) {
        await this.audit.log({
          studioId,
          actorUserId,
          action: 'MEMBERSHIP_PLAN_CLASS_ACCESS_GRANTED',
          entityType: 'membership_plan',
          entityId: planId,
          metadata: toAuditMetadata({
            planName,
            classTemplateId: templateId,
            classTemplateName: nameById.get(templateId) ?? null,
          }),
        });
      }
    }

    for (const templateId of beforeIds) {
      if (!afterIds.has(templateId)) {
        await this.audit.log({
          studioId,
          actorUserId,
          action: 'MEMBERSHIP_PLAN_CLASS_ACCESS_REVOKED',
          entityType: 'membership_plan',
          entityId: planId,
          metadata: toAuditMetadata({
            planName,
            classTemplateId: templateId,
            classTemplateName: nameById.get(templateId) ?? null,
          }),
        });
      }
    }
  }

  async softDeletePlan(studioId: string, planId: string, actorUserId?: string): Promise<void> {
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
    if (actorUserId) {
      await this.audit.log({
        studioId,
        actorUserId,
        action: 'MEMBERSHIP_PLAN_ARCHIVED',
        entityType: 'membership_plan',
        entityId: planId,
        metadata: { planName: plan.name },
      });
    }
  }

  async listPlanConfigurationHistory(
    studioId: string,
    planId: string,
    limit = 20,
  ): Promise<
    Array<{
      id: string;
      action: string;
      createdAt: Date;
      actor: { id: string; firstName: string; lastName: string };
      metadata: Prisma.JsonValue;
    }>
  > {
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: planId, studioId, deletedAt: null },
      select: { id: true },
    });
    if (!plan) {
      throw new NotFoundException('Membership plan not found');
    }

    return this.prisma.auditLog.findMany({
      where: {
        studioId,
        entityType: 'membership_plan',
        entityId: planId,
        action: {
          in: [
            'MEMBERSHIP_PLAN_CREATED',
            'MEMBERSHIP_PLAN_UPDATED',
            'MEMBERSHIP_PLAN_ARCHIVED',
            'MEMBERSHIP_PLAN_CLASS_ACCESS_GRANTED',
            'MEMBERSHIP_PLAN_CLASS_ACCESS_REVOKED',
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 50),
      select: {
        id: true,
        action: true,
        createdAt: true,
        metadata: true,
        actor: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  private diffPlanChanges(
    before: PlanWithAccess,
    after: MembershipPlan & { classAccess: PlanClassAccessDto },
    dto: UpdateMembershipPlanDto,
  ): Array<{ field: string; oldValue: unknown; newValue: unknown }> {
    const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
    const track = (field: string, oldValue: unknown, newValue: unknown) => {
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes.push({ field, oldValue, newValue });
      }
    };

    if (dto.name !== undefined) track('name', before.name, after.name);
    if (dto.description !== undefined) track('description', before.description, after.description);
    if (dto.priceCents !== undefined) track('priceCents', before.priceCents, after.priceCents);
    if (dto.currency !== undefined) track('currency', before.currency, after.currency);
    if (dto.billingInterval !== undefined) track('billingInterval', before.billingInterval, after.billingInterval);
    if (dto.classCredits !== undefined) track('classCredits', before.classCredits, after.classCredits);
    if (dto.entitlementDays !== undefined) track('entitlementDays', before.entitlementDays, after.entitlementDays);
    if (dto.active !== undefined) track('active', before.active, after.active);
    if (dto.allClassesAccess !== undefined) track('allClassesAccess', before.allClassesAccess, after.allClassesAccess);
    return changes;
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
