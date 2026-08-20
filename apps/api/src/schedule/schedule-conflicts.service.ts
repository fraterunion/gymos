import { BadRequestException, Injectable } from '@nestjs/common';
import { BookingStatus, ClassStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { occurrenceDedupKey } from './schedule-occurrence-key';

export type ScheduleConflictKind =
  | 'DUPLICATE_OCCURRENCE'
  | 'INSTRUCTOR_OVERLAP'
  | 'CAPACITY_BELOW_BOOKINGS';

export type ScheduleConflictSeverity = 'BLOCKING' | 'WARNING';

export type ScheduleConflict = {
  kind: ScheduleConflictKind;
  severity: ScheduleConflictSeverity;
  message: string;
  scheduledClassId?: string;
  localDateKey?: string;
  startTime?: string;
};

export type OccurrenceSlot = {
  classTemplateId: string;
  instructorId: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  excludeScheduledClassId?: string;
};

@Injectable()
export class ScheduleConflictsService {
  constructor(private readonly prisma: PrismaService) {}

  async findConflictsForSlots(
    studioId: string,
    slots: OccurrenceSlot[],
  ): Promise<ScheduleConflict[]> {
    const conflicts: ScheduleConflict[] = [];
    if (slots.length === 0) return conflicts;

    const minStart = new Date(Math.min(...slots.map((s) => s.startsAt.getTime())));
    const maxEnd = new Date(Math.max(...slots.map((s) => s.endsAt.getTime())));

    const existing = await this.prisma.scheduledClass.findMany({
      where: {
        studioId,
        status: ClassStatus.SCHEDULED,
        startsAt: { lt: maxEnd },
        endsAt: { gt: minStart },
      },
      select: {
        id: true,
        classTemplateId: true,
        instructorId: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        classTemplate: { select: { name: true } },
        instructor: { select: { firstName: true, lastName: true } },
        _count: {
          select: {
            bookings: { where: { status: BookingStatus.CONFIRMED } },
          },
        },
      },
    });

    for (const slot of slots) {
      const key = occurrenceDedupKey(slot.classTemplateId, slot.startsAt);
      const dup = existing.find(
        (e) =>
          e.id !== slot.excludeScheduledClassId &&
          occurrenceDedupKey(e.classTemplateId, e.startsAt) === key,
      );
      if (dup) {
        conflicts.push({
          kind: 'DUPLICATE_OCCURRENCE',
          severity: 'BLOCKING',
          message: `A ${dup.classTemplate.name} session already exists at this time.`,
          scheduledClassId: dup.id,
        });
      }

      if (slot.instructorId) {
        const overlap = existing.find(
          (e) =>
            e.id !== slot.excludeScheduledClassId &&
            e.instructorId === slot.instructorId &&
            e.startsAt < slot.endsAt &&
            e.endsAt > slot.startsAt,
        );
        if (overlap) {
          const name = overlap.instructor
            ? `${overlap.instructor.firstName} ${overlap.instructor.lastName}`
            : 'Instructor';
          conflicts.push({
            kind: 'INSTRUCTOR_OVERLAP',
            severity: 'WARNING',
            message: `${name} already teaches ${overlap.classTemplate.name} at this time.`,
            scheduledClassId: overlap.id,
          });
        }
      }

      if (slot.capacity <= 0) {
        conflicts.push({
          kind: 'CAPACITY_BELOW_BOOKINGS',
          severity: 'BLOCKING',
          message: 'Capacity must be greater than 0.',
        });
      }
    }

    return conflicts;
  }

  async assertCapacityNotBelowBookings(
    scheduledClassId: string,
    nextCapacity: number,
  ): Promise<void> {
    const row = await this.prisma.scheduledClass.findUnique({
      where: { id: scheduledClassId },
      select: {
        _count: {
          select: {
            bookings: { where: { status: BookingStatus.CONFIRMED } },
          },
        },
      },
    });
    const confirmed = row?._count.bookings ?? 0;
    if (nextCapacity < confirmed) {
      throw new BadRequestException(
        `Capacity cannot be reduced below ${confirmed} confirmed reservation(s).`,
      );
    }
  }

  partitionConflicts(conflicts: ScheduleConflict[]): {
    blocking: ScheduleConflict[];
    warnings: ScheduleConflict[];
  } {
    return {
      blocking: conflicts.filter((c) => c.severity === 'BLOCKING'),
      warnings: conflicts.filter((c) => c.severity === 'WARNING'),
    };
  }
}
