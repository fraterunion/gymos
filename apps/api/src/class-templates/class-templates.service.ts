import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ClassTemplate, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateClassTemplateDto } from './dto/create-class-template.dto';
import type { UpdateClassTemplateDto } from './dto/update-class-template.dto';

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
    };
    if (Object.keys(data).length === 0) {
      return existing;
    }
    return this.prisma.classTemplate.update({
      where: { id: templateId },
      data,
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
