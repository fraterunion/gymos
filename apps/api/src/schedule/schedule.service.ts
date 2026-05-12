import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, ScheduledClass } from '@prisma/client';
import { ClassStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ScheduleQueryDto } from './dto/schedule-query.dto';
import type {
  CancelScheduledClassDto,
  CreateScheduledClassDto,
  UpdateScheduledClassDto,
} from './dto/scheduled-class.dto';

const scheduleInclude = {
  classTemplate: {
    select: {
      id: true,
      name: true,
      durationMinutes: true,
      description: true,
      defaultCapacity: true,
      color: true,
    },
  },
  instructor: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
    },
  },
} satisfies Prisma.ScheduledClassInclude;

@Injectable()
export class ScheduleService {
  constructor(private readonly prisma: PrismaService) {}

  async listSchedule(studioId: string, query: ScheduleQueryDto) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid from or to date');
    }
    if (from >= to) {
      throw new BadRequestException('from must be before to');
    }
    return this.prisma.scheduledClass.findMany({
      where: {
        studioId,
        startsAt: { lt: to },
        endsAt: { gt: from },
        classTemplate: { deletedAt: null },
      },
      include: scheduleInclude,
      orderBy: { startsAt: 'asc' },
    });
  }

  async createScheduledClass(
    studioId: string,
    dto: CreateScheduledClassDto,
  ): Promise<ScheduledClass> {
    if (dto.startTime >= dto.endTime) {
      throw new BadRequestException('startTime must be before endTime');
    }
    const template = await this.prisma.classTemplate.findFirst({
      where: { id: dto.templateId, studioId, deletedAt: null },
    });
    if (!template) {
      throw new NotFoundException('Class template not found');
    }
    const capacity = dto.capacity ?? template.defaultCapacity;
    if (capacity <= 0) {
      throw new BadRequestException('capacity must be greater than 0');
    }
    if (dto.instructorId) {
      await this.assertActiveStudioMember(studioId, dto.instructorId);
    }
    return this.prisma.scheduledClass.create({
      data: {
        studioId,
        classTemplateId: template.id,
        startsAt: dto.startTime,
        endsAt: dto.endTime,
        capacity,
        instructorId: dto.instructorId ?? null,
        status: ClassStatus.SCHEDULED,
      },
    });
  }

  async updateScheduledClass(
    studioId: string,
    scheduledClassId: string,
    dto: UpdateScheduledClassDto,
  ): Promise<ScheduledClass> {
    const existing = await this.prisma.scheduledClass.findFirst({
      where: { id: scheduledClassId, studioId },
    });
    if (!existing) {
      throw new NotFoundException('Scheduled class not found');
    }
    if (dto.instructorId) {
      await this.assertActiveStudioMember(studioId, dto.instructorId);
    }
    const nextStart = dto.startTime ?? existing.startsAt;
    const nextEnd = dto.endTime ?? existing.endsAt;
    if (nextStart >= nextEnd) {
      throw new BadRequestException('startTime must be before endTime');
    }
    if (dto.capacity !== undefined && dto.capacity <= 0) {
      throw new BadRequestException('capacity must be greater than 0');
    }
    const data: Prisma.ScheduledClassUpdateInput = {
      ...(dto.startTime !== undefined ? { startsAt: dto.startTime } : {}),
      ...(dto.endTime !== undefined ? { endsAt: dto.endTime } : {}),
      ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
      ...(dto.instructorId !== undefined ? { instructorId: dto.instructorId } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.cancelReason !== undefined ? { cancelReason: dto.cancelReason } : {}),
    };
    if (Object.keys(data).length === 0) {
      return existing;
    }
    return this.prisma.scheduledClass.update({
      where: { id: scheduledClassId },
      data,
    });
  }

  async cancelScheduledClass(
    studioId: string,
    scheduledClassId: string,
    dto?: CancelScheduledClassDto,
  ): Promise<void> {
    const existing = await this.prisma.scheduledClass.findFirst({
      where: { id: scheduledClassId, studioId },
    });
    if (!existing) {
      throw new NotFoundException('Scheduled class not found');
    }
    await this.prisma.scheduledClass.update({
      where: { id: scheduledClassId },
      data: {
        status: ClassStatus.CANCELLED,
        ...(dto?.cancelReason !== undefined && dto.cancelReason !== ''
          ? { cancelReason: dto.cancelReason }
          : {}),
      },
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
