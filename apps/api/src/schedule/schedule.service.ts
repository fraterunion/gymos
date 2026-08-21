import {
  BadRequestException,
  ConflictException,
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
  studioLocalTimeToUtc,
} from '../common/date/studio-local-date';
import type { ScheduleQueryDto } from './dto/schedule-query.dto';
import type {
  CancelScheduledClassDto,
  CreateScheduledClassDto,
  UpdateScheduledClassDto,
} from './dto/scheduled-class.dto';
import type { StudioLocalDateTimeDto } from './dto/studio-local-datetime.dto';
import { ScheduleConflictsService } from './schedule-conflicts.service';
import { cascadeClassCancellationInTx } from './cascade-class-cancellation';
import { assertStartsBeforeEnds } from './occurrence-interval';

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
    scheduleTemplate: {
      select: {
        id: true,
        dayOfWeek: true,
        startTime: true,
        startsAt: true,
        endsAt: true,
        intervalWeeks: true,
        active: true,
      },
    },
  } satisfies Prisma.ScheduledClassInclude;
}

@Injectable()
export class ScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conflicts: ScheduleConflictsService,
  ) {}

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
    const studio = await this.requireStudioTimezone(studioId);
    const template = await this.prisma.classTemplate.findFirst({
      where: { id: dto.templateId, studioId, deletedAt: null },
    });
    if (!template) {
      throw new NotFoundException('Class template not found');
    }

    const { startsAt, endsAt } = this.resolveOccurrenceTimes(
      dto.localStart,
      dto.localEnd,
      dto.startTime,
      dto.endTime,
      studio.timezone,
      template.durationMinutes,
    );

    if (startsAt >= endsAt) {
      throw new BadRequestException('startTime must be before endTime');
    }

    const capacity = dto.capacity ?? template.defaultCapacity;
    if (capacity <= 0) {
      throw new BadRequestException('capacity must be greater than 0');
    }
    if (dto.instructorId) {
      await this.assertActiveStudioMember(studioId, dto.instructorId);
    }

    await this.assertNoDuplicateSlot(studioId, template.id, startsAt);

    const slotConflicts = await this.conflicts.findConflictsForSlots(studioId, [
      {
        classTemplateId: template.id,
        instructorId: dto.instructorId ?? null,
        startsAt,
        endsAt,
        capacity,
      },
    ]);
    const { blocking } = this.conflicts.partitionConflicts(slotConflicts);
    if (blocking.length > 0) {
      throw new ConflictException({
        message: 'Cannot create class due to conflicts.',
        conflicts: blocking,
      });
    }

    return this.prisma.scheduledClass.create({
      data: {
        studioId,
        classTemplateId: template.id,
        startsAt,
        endsAt,
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
    const studio = await this.requireStudioTimezone(studioId);
    const existing = await this.prisma.scheduledClass.findFirst({
      where: { id: scheduledClassId, studioId },
      include: { classTemplate: true },
    });
    if (!existing) {
      throw new NotFoundException('Scheduled class not found');
    }
    if (dto.instructorId) {
      await this.assertActiveStudioMember(studioId, dto.instructorId);
    }

    const resolved = this.resolveOccurrenceTimes(
      dto.localStart,
      dto.localEnd,
      dto.startTime ?? (dto.localStart ? undefined : existing.startsAt),
      dto.endTime ?? (dto.localEnd ? undefined : existing.endsAt),
      studio.timezone,
      existing.classTemplate.durationMinutes,
      existing.startsAt,
      existing.endsAt,
    );

    const nextStart = dto.localStart || dto.startTime !== undefined ? resolved.startsAt : existing.startsAt;
    const nextEnd = dto.localEnd || dto.endTime !== undefined ? resolved.endsAt : existing.endsAt;

    if (nextStart >= nextEnd) {
      throw new BadRequestException('startTime must be before endTime');
    }
    if (dto.capacity !== undefined && dto.capacity <= 0) {
      throw new BadRequestException('capacity must be greater than 0');
    }
    if (dto.capacity !== undefined) {
      await this.conflicts.assertCapacityNotBelowBookings(scheduledClassId, dto.capacity);
    }

    if (nextStart.getTime() !== existing.startsAt.getTime()) {
      await this.assertNoDuplicateSlot(
        studioId,
        existing.classTemplateId,
        nextStart,
        scheduledClassId,
      );
    }

    const data: Prisma.ScheduledClassUpdateInput = {
      ...(dto.localStart || dto.startTime !== undefined ? { startsAt: nextStart } : {}),
      ...(dto.localEnd || dto.endTime !== undefined ? { endsAt: nextEnd } : {}),
      ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
      ...(dto.instructorId !== undefined ? { instructorId: dto.instructorId } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.cancelReason !== undefined ? { cancelReason: dto.cancelReason } : {}),
    };
    if (Object.keys(data).length === 0) {
      return existing;
    }

    const transitioningToCancelled =
      dto.status === ClassStatus.CANCELLED && existing.status !== ClassStatus.CANCELLED;

    if (transitioningToCancelled) {
      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.scheduledClass.update({
          where: { id: scheduledClassId },
          data,
        });
        await cascadeClassCancellationInTx(tx, {
          studioId,
          scheduledClassIds: [scheduledClassId],
        });
        return updated;
      });
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
    if (existing.status === ClassStatus.CANCELLED) {
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.scheduledClass.update({
        where: { id: scheduledClassId },
        data: {
          status: ClassStatus.CANCELLED,
          ...(dto?.cancelReason !== undefined && dto.cancelReason !== ''
            ? { cancelReason: dto.cancelReason }
            : {}),
        },
      });
      await cascadeClassCancellationInTx(tx, {
        studioId,
        scheduledClassIds: [scheduledClassId],
      });
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

  resolveOccurrenceTimes(
    localStart: StudioLocalDateTimeDto | undefined,
    localEnd: StudioLocalDateTimeDto | undefined,
    startTime: Date | undefined,
    endTime: Date | undefined,
    timezone: string,
    durationMinutes: number,
    fallbackStart?: Date,
    fallbackEnd?: Date,
  ): { startsAt: Date; endsAt: Date } {
    let startsAt: Date;
    let endsAt: Date;
    if (localStart) {
      startsAt = studioLocalTimeToUtc(localStart.date, localStart.time, timezone);
      endsAt = localEnd
        ? studioLocalTimeToUtc(localEnd.date, localEnd.time, timezone)
        : new Date(startsAt.getTime() + durationMinutes * 60_000);
    } else if (startTime && endTime) {
      startsAt = startTime;
      endsAt = endTime;
    } else if (fallbackStart && fallbackEnd) {
      startsAt = fallbackStart;
      endsAt = fallbackEnd;
    } else {
      throw new BadRequestException(
        'Provide localStart/localEnd or startTime/endTime for scheduling.',
      );
    }
    assertStartsBeforeEnds(startsAt, endsAt);
    return { startsAt, endsAt };
  }

  private async requireStudioTimezone(studioId: string) {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { timezone: true },
    });
    if (!studio) throw new NotFoundException('Studio not found');
    return studio;
  }

  private async assertNoDuplicateSlot(
    studioId: string,
    classTemplateId: string,
    startsAt: Date,
    excludeId?: string,
  ) {
    const existing = await this.prisma.scheduledClass.findFirst({
      where: {
        studioId,
        classTemplateId,
        startsAt,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    if (existing) {
      throw new ConflictException(
        'A class with this type and start time already exists.',
      );
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
