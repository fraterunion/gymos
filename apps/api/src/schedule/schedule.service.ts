import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, ScheduledClass } from '@prisma/client';
import { BookingStatus, ClassStatus, WaitlistStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  addDaysToDateKey,
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
} from '../common/date/studio-local-date';
import type { ScheduleQueryDto } from './dto/schedule-query.dto';
import type {
  CancelScheduledClassDto,
  CreateScheduledClassDto,
  UpdateScheduledClassDto,
} from './dto/scheduled-class.dto';

function scheduleInclude(studioId: string) {
  return {
    classTemplate: {
      select: {
        id: true,
        name: true,
        durationMinutes: true,
        description: true,
        defaultCapacity: true,
        color: true,
        intensityLevel: true,
        category: true,
        equipment: true,
        heroImageUrl: true,
        thumbnailImageUrl: true,
        tags: true,
        isFeatured: true,
        difficultyLabel: true,
        caloriesEstimateMin: true,
        caloriesEstimateMax: true,
        cancellationWindowHours: true,
        waitlistCapacity: true,
      },
    },
    instructor: {
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        staffProfiles: {
          where: { studioId },
          select: {
            staffType: true,
            bio: true,
            photoUrl: true,
            specialties: true,
          },
          take: 1,
        },
      },
    },
  } satisfies Prisma.ScheduledClassInclude;
}

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
    const rows = await this.prisma.scheduledClass.findMany({
      where: {
        studioId,
        status: ClassStatus.SCHEDULED,
        startsAt: { lt: to },
        endsAt: { gt: from },
        classTemplate: { deletedAt: null },
      },
      include: {
        ...scheduleInclude(studioId),
        _count: {
          select: {
            bookings: { where: { status: BookingStatus.CONFIRMED } },
          },
        },
      },
      orderBy: { startsAt: 'asc' },
    });
    return rows.map(({ _count, ...row }) => ({
      ...row,
      bookedCount: _count.bookings,
    }));
  }

  async getScheduledClassById(studioId: string, scheduledClassId: string) {
    const row = await this.prisma.scheduledClass.findFirst({
      where: {
        id: scheduledClassId,
        studioId,
        classTemplate: { deletedAt: null },
      },
      include: {
        ...scheduleInclude(studioId),
        studio: { select: { checkInWindowMinutes: true } },
        _count: {
          select: {
            bookings: {
              where: {
                status: BookingStatus.CONFIRMED,
                user: { deletedAt: null },
              },
            },
            attendances: {
              where: { user: { deletedAt: null } },
            },
            waitlist: {
              where: {
                status: WaitlistStatus.WAITING,
                user: { deletedAt: null },
              },
            },
          },
        },
      },
    });
    if (!row) {
      throw new NotFoundException('Scheduled class not found');
    }
    const { _count, studio, ...rest } = row;
    return {
      ...rest,
      checkInWindowMinutes: studio.checkInWindowMinutes,
      bookedCount: _count.bookings,
      waitlistCount: _count.waitlist,
      checkedInCount: _count.attendances,
    };
  }

  async listPublicSchedule(studioId: string, query: ScheduleQueryDto) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid from or to date');
    }
    if (from >= to) {
      throw new BadRequestException('from must be before to');
    }
    const rows = await this.prisma.scheduledClass.findMany({
      where: {
        studioId,
        status: ClassStatus.SCHEDULED,
        startsAt: { lt: to },
        endsAt: { gt: from },
        classTemplate: { deletedAt: null },
      },
      include: {
        ...scheduleInclude(studioId),
        _count: {
          select: {
            bookings: { where: { status: BookingStatus.CONFIRMED } },
          },
        },
      },
      orderBy: { startsAt: 'asc' },
    });
    return rows.map(({ _count, ...row }) => ({
      ...row,
      bookedCount: _count.bookings,
    }));
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

  async getTodaySummaryForStaff(studioId: string, now: Date = new Date()) {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { timezone: true },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }

    // Compute the UTC window that spans today in the studio's local timezone.
    // dayStart = local midnight (00:00:00) in UTC.
    // dayEnd   = next local midnight (00:00:00) in UTC.
    // DST-safe: studioLocalDateKeyToUtcAnchor handles the offset for each boundary
    // independently, so a 23- or 25-hour DST day is handled correctly.
    const dayKey = getStudioLocalDateKey(now, studio.timezone);
    const dayStart = studioLocalDateKeyToUtcAnchor(dayKey, studio.timezone);
    const nextDayKey = addDaysToDateKey(dayKey, 1);
    const dayEnd = studioLocalDateKeyToUtcAnchor(nextDayKey, studio.timezone);

    const rows = await this.prisma.scheduledClass.findMany({
      where: {
        studioId,
        status: ClassStatus.SCHEDULED,
        startsAt: { lt: dayEnd },
        endsAt:   { gt: dayStart },
        classTemplate: { deletedAt: null },
      },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        status: true,
        classTemplate: { select: { name: true, color: true } },
        instructor:    { select: { firstName: true, lastName: true } },
        _count: {
          select: {
            bookings:    { where: { status: BookingStatus.CONFIRMED } },
            attendances: true,
          },
        },
      },
      orderBy: { startsAt: 'asc' },
    });

    return rows.map((row) => ({
      scheduledClassId: row.id,
      className:        row.classTemplate.name,
      color:            row.classTemplate.color,
      startsAt:         row.startsAt.toISOString(),
      endsAt:           row.endsAt.toISOString(),
      capacity:         row.capacity,
      status:           row.status,
      instructor:       row.instructor
        ? { firstName: row.instructor.firstName, lastName: row.instructor.lastName }
        : null,
      bookedCount:      row._count.bookings,
      checkedInCount:   row._count.attendances,
    }));
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
