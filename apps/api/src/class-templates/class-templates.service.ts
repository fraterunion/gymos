import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ClassTemplate, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isClassIncludedInPlan } from '../membership-plans/membership-plan-class-access.utils';
import type { CreateClassTemplateDto } from './dto/create-class-template.dto';
import type { UpdateClassTemplateDto } from './dto/update-class-template.dto';
import type { ClassAccessSummaryDto } from './dto/class-access-summary.dto';

const templateListInclude = {
  defaultInstructor: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
    },
  },
} satisfies Prisma.ClassTemplateInclude;

@Injectable()
export class ClassTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async listTemplates(studioId: string) {
    return this.prisma.classTemplate.findMany({
      where: { studioId, deletedAt: null },
      include: templateListInclude,
      orderBy: [{ isFeatured: 'desc' }, { name: 'asc' }],
    });
  }

  async createTemplate(studioId: string, dto: CreateClassTemplateDto): Promise<ClassTemplate> {
    if (dto.instructorId) {
      await this.assertActiveStudioMember(studioId, dto.instructorId);
    }
    this.assertValidAccessWindow(
      dto.accessWindowStart ?? null,
      dto.accessWindowEnd ?? null,
    );
    return this.prisma.classTemplate.create({
      data: {
        studioId,
        name: dto.name,
        description: dto.description ?? null,
        durationMinutes: dto.durationMinutes,
        defaultCapacity: dto.defaultCapacity ?? 10,
        color: dto.color ?? null,
        defaultInstructorId: dto.instructorId ?? null,
        intensityLevel: dto.intensityLevel ?? null,
        category: dto.category ?? null,
        equipment: dto.equipment ?? [],
        heroImageUrl: dto.heroImageUrl ?? null,
        thumbnailImageUrl: dto.thumbnailImageUrl ?? null,
        tags: dto.tags ?? [],
        isFeatured: dto.isFeatured ?? false,
        difficultyLabel: dto.difficultyLabel ?? null,
        caloriesEstimateMin: dto.caloriesEstimateMin ?? null,
        caloriesEstimateMax: dto.caloriesEstimateMax ?? null,
        cancellationWindowHours: dto.cancellationWindowHours ?? null,
        waitlistCapacity: dto.waitlistCapacity ?? null,
        isOpenGymSlot: dto.isOpenGymSlot ?? false,
        accessWindowStart: dto.accessWindowStart ?? null,
        accessWindowEnd: dto.accessWindowEnd ?? null,
      },
    });
  }

  async updateTemplate(
    studioId: string,
    templateId: string,
    dto: UpdateClassTemplateDto,
  ): Promise<ClassTemplate> {
    const existing = await this.prisma.classTemplate.findFirst({
      where: { id: templateId, studioId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException('Class template not found');
    }
    if (dto.instructorId) {
      await this.assertActiveStudioMember(studioId, dto.instructorId);
    }
    const nextAccessWindowStart =
      dto.accessWindowStart !== undefined ? dto.accessWindowStart : existing.accessWindowStart;
    const nextAccessWindowEnd =
      dto.accessWindowEnd !== undefined ? dto.accessWindowEnd : existing.accessWindowEnd;
    if (dto.accessWindowStart !== undefined || dto.accessWindowEnd !== undefined) {
      this.assertValidAccessWindow(nextAccessWindowStart, nextAccessWindowEnd);
    }
    const data: Prisma.ClassTemplateUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.durationMinutes !== undefined ? { durationMinutes: dto.durationMinutes } : {}),
      ...(dto.defaultCapacity !== undefined ? { defaultCapacity: dto.defaultCapacity } : {}),
      ...(dto.color !== undefined ? { color: dto.color } : {}),
      ...(dto.instructorId !== undefined ? { defaultInstructorId: dto.instructorId } : {}),
      ...(dto.intensityLevel !== undefined ? { intensityLevel: dto.intensityLevel } : {}),
      ...(dto.category !== undefined ? { category: dto.category } : {}),
      ...(dto.equipment !== undefined ? { equipment: dto.equipment } : {}),
      ...(dto.heroImageUrl !== undefined ? { heroImageUrl: dto.heroImageUrl } : {}),
      ...(dto.thumbnailImageUrl !== undefined ? { thumbnailImageUrl: dto.thumbnailImageUrl } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.isFeatured !== undefined ? { isFeatured: dto.isFeatured } : {}),
      ...(dto.difficultyLabel !== undefined ? { difficultyLabel: dto.difficultyLabel } : {}),
      ...(dto.caloriesEstimateMin !== undefined ? { caloriesEstimateMin: dto.caloriesEstimateMin } : {}),
      ...(dto.caloriesEstimateMax !== undefined ? { caloriesEstimateMax: dto.caloriesEstimateMax } : {}),
      ...(dto.cancellationWindowHours !== undefined ? { cancellationWindowHours: dto.cancellationWindowHours } : {}),
      ...(dto.waitlistCapacity !== undefined ? { waitlistCapacity: dto.waitlistCapacity } : {}),
      ...(dto.isOpenGymSlot !== undefined ? { isOpenGymSlot: dto.isOpenGymSlot } : {}),
      ...(dto.accessWindowStart !== undefined ? { accessWindowStart: dto.accessWindowStart } : {}),
      ...(dto.accessWindowEnd !== undefined ? { accessWindowEnd: dto.accessWindowEnd } : {}),
    };
    if (Object.keys(data).length === 0) {
      return existing;
    }
    return this.prisma.classTemplate.update({
      where: { id: templateId },
      data,
    });
  }

  // Batched (3 queries total, independent of template/plan count) — avoids N+1 from
  // computing per-template access in the browser or issuing one request per template.
  // Reuses the same isClassIncludedInPlan rule the booking engine enforces, so this
  // summary can never drift from what actually gets a member into a class.
  async listAccessSummary(studioId: string): Promise<ClassAccessSummaryDto[]> {
    const [templates, plans, dayPassRows] = await Promise.all([
      this.prisma.classTemplate.findMany({
        where: { studioId, deletedAt: null },
        select: {
          id: true,
          name: true,
          category: true,
          isOpenGymSlot: true,
          accessWindowStart: true,
          accessWindowEnd: true,
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.membershipPlan.findMany({
        where: { studioId, deletedAt: null, active: true },
        select: {
          id: true,
          name: true,
          allClassesAccess: true,
          allowedCategories: true,
          classTemplateAccess: { select: { classTemplateId: true } },
        },
      }),
      this.prisma.dayPassClassAccess.findMany({
        where: { studioId },
        select: { classTemplateId: true },
      }),
    ]);

    const dayPassAllowedIds = new Set(dayPassRows.map((r) => r.classTemplateId));

    return templates.map((template) => {
      const allowingPlans = plans.filter((plan) =>
        isClassIncludedInPlan({
          allClassesAccess: plan.allClassesAccess,
          allowedTemplateIds: plan.classTemplateAccess.map((row) => row.classTemplateId),
          allowedCategories: plan.allowedCategories,
          classTemplateId: template.id,
          templateCategory: template.category,
        }),
      );
      const dayPassAllowed = dayPassAllowedIds.has(template.id);
      return {
        id: template.id,
        name: template.name,
        category: template.category,
        isOpenGymSlot: template.isOpenGymSlot,
        accessWindowStart: template.accessWindowStart,
        accessWindowEnd: template.accessWindowEnd,
        planCount: allowingPlans.length,
        planNames: allowingPlans.map((p) => p.name),
        dayPassAllowed,
        orphan: allowingPlans.length === 0 && !dayPassAllowed,
      };
    });
  }

  async softDeleteTemplate(studioId: string, templateId: string): Promise<void> {
    const existing = await this.prisma.classTemplate.findFirst({
      where: { id: templateId, studioId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException('Class template not found');
    }
    await this.prisma.classTemplate.update({
      where: { id: templateId },
      data: { deletedAt: new Date() },
    });
  }

  // Both bounds must be set together, and start must precede end. HH:mm zero-padded 24h strings
  // compare correctly lexicographically, so plain string comparison is sufficient here.
  private assertValidAccessWindow(start: string | null, end: string | null): void {
    if (start === null && end === null) return;
    if (start === null || end === null) {
      throw new BadRequestException(
        'accessWindowStart and accessWindowEnd must be set together.',
      );
    }
    if (start >= end) {
      throw new BadRequestException('accessWindowStart must be earlier than accessWindowEnd.');
    }
  }

  private async assertActiveStudioMember(studioId: string, userId: string): Promise<void> {
    const row = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId, deletedAt: null },
      include: { user: { select: { deletedAt: true } } },
    });
    if (!row || row.user.deletedAt) {
      throw new BadRequestException('instructorId must be an active member of this studio');
    }
  }
}
