import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateScheduleTemplateDto } from './dto/create-schedule-template.dto';
import type { UpdateScheduleTemplateDto } from './dto/update-schedule-template.dto';

@Injectable()
export class ScheduleTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(studioId: string) {
    return this.prisma.scheduleTemplate.findMany({
      where: { studioId, deletedAt: null },
      include: {
        classTemplate: {
          select: { id: true, name: true, durationMinutes: true, color: true, defaultCapacity: true },
        },
        instructor: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });
  }

  async create(studioId: string, dto: CreateScheduleTemplateDto) {
    const template = await this.prisma.classTemplate.findFirst({
      where: { id: dto.classTemplateId, studioId, deletedAt: null },
    });
    if (!template) throw new NotFoundException('Class template not found');

    if (dto.instructorId) {
      await this.assertActiveStudioMember(studioId, dto.instructorId);
    }

    return this.prisma.scheduleTemplate.create({
      data: {
        studioId,
        classTemplateId: dto.classTemplateId,
        instructorId: dto.instructorId ?? null,
        dayOfWeek: dto.dayOfWeek,
        startTime: dto.startTime,
        capacity: dto.capacity ?? null,
        active: true,
      },
      include: {
        classTemplate: {
          select: { id: true, name: true, durationMinutes: true, color: true, defaultCapacity: true },
        },
        instructor: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async update(studioId: string, id: string, dto: UpdateScheduleTemplateDto) {
    const existing = await this.prisma.scheduleTemplate.findFirst({
      where: { id, studioId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Schedule template not found');

    if (dto.classTemplateId) {
      const ct = await this.prisma.classTemplate.findFirst({
        where: { id: dto.classTemplateId, studioId, deletedAt: null },
      });
      if (!ct) throw new NotFoundException('Class template not found');
    }

    if (dto.instructorId) {
      await this.assertActiveStudioMember(studioId, dto.instructorId);
    }

    return this.prisma.scheduleTemplate.update({
      where: { id },
      data: {
        ...(dto.classTemplateId !== undefined ? { classTemplateId: dto.classTemplateId } : {}),
        ...(dto.instructorId !== undefined ? { instructorId: dto.instructorId } : {}),
        ...(dto.dayOfWeek !== undefined ? { dayOfWeek: dto.dayOfWeek } : {}),
        ...(dto.startTime !== undefined ? { startTime: dto.startTime } : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
      include: {
        classTemplate: {
          select: { id: true, name: true, durationMinutes: true, color: true, defaultCapacity: true },
        },
        instructor: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async remove(studioId: string, id: string): Promise<void> {
    const existing = await this.prisma.scheduleTemplate.findFirst({
      where: { id, studioId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Schedule template not found');

    await this.prisma.scheduleTemplate.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  private async assertActiveStudioMember(
    studioId: string,
    userId: string,
  ): Promise<void> {
    const row = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId, deletedAt: null },
      include: { user: { select: { deletedAt: true } } },
    });
    if (!row || row.user.deletedAt) {
      throw new BadRequestException(
        'instructorId must be an active member of this studio',
      );
    }
  }
}
