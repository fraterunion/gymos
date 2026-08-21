import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingStatus,
  ClassStatus,
  ScheduleOccurrenceExceptionKind,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import {
  addDaysToDateKey,
  getStudioLocalDateKey,
  getStudioLocalHHmm,
  studioLocalDateKeyToUtcAnchor,
  studioLocalTimeToUtc,
} from '../common/date/studio-local-date';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import {
  BulkScheduleOperation,
  BulkScheduleOperationDto,
  DuplicateClassDto,
  DuplicateWeekDto,
} from './dto/schedule-operations.dto';
import {
  OccurrenceSlot,
  ScheduleConflictsService,
} from './schedule-conflicts.service';
import { acquireOperationAdvisoryLock } from './schedule-occurrence-concurrency';
import { insertScheduledOccurrenceOrSkip } from './schedule-occurrence-insert';
import {
  buildPreviewResult,
  emptyOperationResult,
  type ScheduleOperationResult,
} from './schedule-operation-result';

type ProposedSlot = OccurrenceSlot & {
  sourceScheduledClassId?: string;
  localDateKey: string;
};

@Injectable()
export class ScheduleOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conflicts: ScheduleConflictsService,
    private readonly audit: AuditService,
  ) {}

  async previewDuplicateClass(
    studioId: string,
    scheduledClassId: string,
    dto: DuplicateClassDto,
  ): Promise<ScheduleOperationResult> {
    const source = await this.requireScheduledClass(studioId, scheduledClassId);
    const studio = await this.requireStudio(studioId);
    const slot = this.buildDuplicateClassSlot(source, dto, studio.timezone);
    return this.previewSlots(studioId, [slot]);
  }

  async executeDuplicateClass(
    studioId: string,
    scheduledClassId: string,
    dto: DuplicateClassDto,
    actorUserId: string,
  ): Promise<ScheduleOperationResult> {
    const action = 'SCHEDULE_CLASS_DUPLICATED';
    const preview = await this.previewDuplicateClass(studioId, scheduledClassId, dto);
    this.assertPreviewAllowed(preview, dto.confirmWarnings);

    return this.prisma.$transaction(async (tx) => {
      if (dto.idempotencyKey) {
        await acquireOperationAdvisoryLock(tx, studioId, action, dto.idempotencyKey);
        const replay = await this.findIdempotentReplayTx(
          tx,
          studioId,
          action,
          dto.idempotencyKey,
        );
        if (replay) return replay;
      }

      const source = await this.requireScheduledClass(studioId, scheduledClassId);
      const studio = await this.requireStudio(studioId);
      const slot = this.buildDuplicateClassSlot(source, dto, studio.timezone);
      const { createdIds, skippedAlreadyExistsCount } = await this.createStandaloneSlotsTx(
        tx,
        studioId,
        [slot],
      );

      const result = emptyOperationResult({
        ...preview,
        createdCount: createdIds.length,
        skippedCount: preview.proposedCount - createdIds.length,
        skippedAlreadyExistsCount,
        affectedClassIds: createdIds,
      });

      if (dto.idempotencyKey) {
        await this.audit.log(
          {
            studioId,
            actorUserId,
            action,
            entityType: 'ScheduledClass',
            entityId: scheduledClassId,
            metadata: {
              idempotencyKey: dto.idempotencyKey,
              sourceScheduledClassId: scheduledClassId,
              createdCount: createdIds.length,
              createdIds,
              result,
            },
          },
          tx,
        );
      } else {
        await this.audit.log(
          {
            studioId,
            actorUserId,
            action,
            entityType: 'ScheduledClass',
            entityId: scheduledClassId,
            metadata: {
              sourceScheduledClassId: scheduledClassId,
              createdCount: createdIds.length,
              createdIds,
              result,
            },
          },
          tx,
        );
      }

      return result;
    });
  }

  async previewDuplicateWeek(
    studioId: string,
    dto: DuplicateWeekDto,
  ): Promise<ScheduleOperationResult> {
    const studio = await this.requireStudio(studioId);
    const targetWeeks = this.resolveTargetWeeks(dto);
    const slots = await this.buildDuplicateWeekSlots(
      studioId,
      studio.timezone,
      dto.sourceWeekStart,
      targetWeeks,
    );
    return this.previewSlots(studioId, slots);
  }

  async executeDuplicateWeek(
    studioId: string,
    dto: DuplicateWeekDto,
    actorUserId: string,
  ): Promise<ScheduleOperationResult> {
    const action = 'SCHEDULE_WEEK_DUPLICATED';
    const preview = await this.previewDuplicateWeek(studioId, dto);
    this.assertPreviewAllowed(preview, dto.confirmWarnings);
    const targetWeeks = this.resolveTargetWeeks(dto);

    return this.prisma.$transaction(async (tx) => {
      if (dto.idempotencyKey) {
        await acquireOperationAdvisoryLock(tx, studioId, action, dto.idempotencyKey);
        const replay = await this.findIdempotentReplayTx(
          tx,
          studioId,
          action,
          dto.idempotencyKey,
        );
        if (replay) return replay;
      }

      const studio = await this.requireStudio(studioId);
      const slots = await this.buildDuplicateWeekSlots(
        studioId,
        studio.timezone,
        dto.sourceWeekStart,
        targetWeeks,
      );
      const { createdIds, skippedAlreadyExistsCount } = await this.createStandaloneSlotsTx(
        tx,
        studioId,
        slots,
      );

      const result = emptyOperationResult({
        ...preview,
        createdCount: createdIds.length,
        skippedCount: preview.proposedCount - createdIds.length,
        skippedAlreadyExistsCount,
        affectedClassIds: createdIds,
      });

      await this.audit.log(
        {
          studioId,
          actorUserId,
          action,
          entityType: 'ScheduleOperation',
          entityId: dto.sourceWeekStart,
          metadata: {
            idempotencyKey: dto.idempotencyKey ?? null,
            sourceWeekStart: dto.sourceWeekStart,
            targetWeekStarts: targetWeeks,
            createdCount: createdIds.length,
            skippedCount: result.skippedCount,
            result,
          },
        },
        dto.idempotencyKey ? tx : undefined,
      );

      return result;
    });
  }

  async previewBulk(
    studioId: string,
    dto: BulkScheduleOperationDto,
  ): Promise<ScheduleOperationResult> {
    if (dto.operation === BulkScheduleOperation.DUPLICATE) {
      const studio = await this.requireStudio(studioId);
      const rows = await this.loadBulkTargets(studioId, dto.scheduledClassIds);
      const slots = this.buildBulkDuplicateSlots(rows, studio.timezone, dto.weekOffsetWeeks ?? 1);
      return this.previewSlots(studioId, slots);
    }

    const rows = await this.loadBulkTargets(studioId, dto.scheduledClassIds);
    const impact = await this.countReservationImpact(rows.map((r) => r.id));
    const conflicts = await this.buildBulkConflicts(studioId, rows, dto);

    return buildPreviewResult({
      proposedCount: rows.length,
      conflicts,
      totalReservations: impact.totalReservations,
    });
  }

  async executeBulk(
    studioId: string,
    dto: BulkScheduleOperationDto,
    actorUserId: string,
  ): Promise<ScheduleOperationResult> {
    const action = this.bulkAuditAction(dto.operation);
    const preview = await this.previewBulk(studioId, dto);
    this.assertPreviewAllowed(preview, dto.confirmWarnings);

    if (
      preview.affectedReservationCount > 0 &&
      this.bulkRequiresReservationConfirm(dto) &&
      !dto.confirmReservations
    ) {
      throw new BadRequestException({
        message: 'Reservation impact requires confirmation.',
        totalReservations: preview.affectedReservationCount,
        requiresConfirmation: true,
      });
    }

    if (dto.operation === BulkScheduleOperation.DUPLICATE) {
      return this.prisma.$transaction(async (tx) => {
        if (dto.idempotencyKey) {
          await acquireOperationAdvisoryLock(tx, studioId, action, dto.idempotencyKey);
          const replay = await this.findIdempotentReplayTx(
            tx,
            studioId,
            action,
            dto.idempotencyKey,
          );
          if (replay) return replay;
        }

        const studio = await this.requireStudio(studioId);
        const rows = await this.loadBulkTargets(studioId, dto.scheduledClassIds);
        const slots = this.buildBulkDuplicateSlots(rows, studio.timezone, dto.weekOffsetWeeks ?? 1);
        const { createdIds, skippedAlreadyExistsCount } = await this.createStandaloneSlotsTx(
          tx,
          studioId,
          slots,
        );

        const result = emptyOperationResult({
          ...preview,
          createdCount: createdIds.length,
          skippedCount: preview.proposedCount - createdIds.length,
          skippedAlreadyExistsCount,
          affectedClassIds: createdIds,
        });

        await this.audit.log(
          {
            studioId,
            actorUserId,
            action,
            entityType: 'ScheduleOperation',
            metadata: {
              idempotencyKey: dto.idempotencyKey ?? null,
              weekOffsetWeeks: dto.weekOffsetWeeks ?? 1,
              sourceClassCount: rows.length,
              createdCount: createdIds.length,
              result,
            },
          },
          dto.idempotencyKey ? tx : undefined,
        );

        return result;
      });
    }

    const rows = await this.loadBulkTargets(studioId, dto.scheduledClassIds);
    const conflicts = await this.buildBulkConflicts(studioId, rows, dto);
    const { blocking } = this.conflicts.partitionConflicts(conflicts);
    if (blocking.length > 0) {
      throw new ConflictException({
        message: 'Blocking conflicts prevent this bulk operation.',
        conflicts: blocking,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.idempotencyKey) {
        await acquireOperationAdvisoryLock(tx, studioId, action, dto.idempotencyKey);
        const replay = await this.findIdempotentReplayTx(
          tx,
          studioId,
          action,
          dto.idempotencyKey,
        );
        if (replay) return replay;
      }

      const ids: string[] = [];
      let updatedCount = 0;
      let cancelledCount = 0;
      for (const row of rows) {
        switch (dto.operation) {
          case BulkScheduleOperation.CHANGE_INSTRUCTOR:
            await tx.scheduledClass.update({
              where: { id: row.id },
              data: {
                instructorId: dto.instructorId ?? null,
                ...(row.scheduleTemplateId
                  ? { exceptionKind: ScheduleOccurrenceExceptionKind.DETACHED }
                  : {}),
              },
            });
            ids.push(row.id);
            updatedCount++;
            break;
          case BulkScheduleOperation.CHANGE_CAPACITY:
            await this.conflicts.assertCapacityNotBelowBookings(row.id, dto.capacity!);
            await tx.scheduledClass.update({
              where: { id: row.id },
              data: {
                capacity: dto.capacity!,
                ...(row.scheduleTemplateId
                  ? { exceptionKind: ScheduleOccurrenceExceptionKind.DETACHED }
                  : {}),
              },
            });
            ids.push(row.id);
            updatedCount++;
            break;
          case BulkScheduleOperation.MOVE_TIME: {
            const deltaMs = (dto.timeDeltaMinutes ?? 0) * 60_000;
            const nextStart = new Date(row.startsAt.getTime() + deltaMs);
            const nextEnd = new Date(row.endsAt.getTime() + deltaMs);
            const moveConflicts = await this.conflicts.findConflictsForSlots(studioId, [
              {
                classTemplateId: row.classTemplateId,
                instructorId: row.instructorId,
                startsAt: nextStart,
                endsAt: nextEnd,
                capacity: row.capacity,
                excludeScheduledClassId: row.id,
              },
            ]);
            const { blocking: moveBlocking } =
              this.conflicts.partitionConflicts(moveConflicts);
            if (moveBlocking.length > 0) {
              throw new ConflictException({
                message: `Time move blocked for class ${row.id}.`,
                conflicts: moveBlocking,
              });
            }
            await tx.scheduledClass.update({
              where: { id: row.id },
              data: {
                startsAt: nextStart,
                endsAt: nextEnd,
                ...(row.scheduleTemplateId
                  ? { exceptionKind: ScheduleOccurrenceExceptionKind.DETACHED }
                  : {}),
              },
            });
            ids.push(row.id);
            updatedCount++;
            break;
          }
          case BulkScheduleOperation.CANCEL:
            await tx.scheduledClass.update({
              where: { id: row.id },
              data: {
                status: ClassStatus.CANCELLED,
                ...(dto.cancelReason ? { cancelReason: dto.cancelReason } : {}),
              },
            });
            ids.push(row.id);
            cancelledCount++;
            break;
          default:
            throw new BadRequestException('Unsupported bulk operation');
        }
      }

      const result = emptyOperationResult({
        ...preview,
        updatedCount,
        cancelledCount,
        affectedClassIds: ids,
      });

      await this.audit.log(
        {
          studioId,
          actorUserId,
          action,
          entityType: 'ScheduleOperation',
          metadata: {
            idempotencyKey: dto.idempotencyKey ?? null,
            operation: dto.operation,
            affectedClassCount: ids.length,
            affectedClassIds: ids,
            affectedReservationCount: preview.affectedReservationCount,
            timeDeltaMinutes: dto.timeDeltaMinutes ?? null,
            instructorId: dto.instructorId ?? null,
            capacity: dto.capacity ?? null,
            result,
          },
        },
        dto.idempotencyKey ? tx : undefined,
      );

      return result;
    });
  }

  private async previewSlots(
    studioId: string,
    slots: ProposedSlot[],
  ): Promise<ScheduleOperationResult> {
    const conflicts = await this.conflicts.findConflictsForSlots(studioId, slots);
    return buildPreviewResult({ proposedCount: slots.length, conflicts });
  }

  private async createStandaloneSlotsTx(
    tx: Prisma.TransactionClient,
    studioId: string,
    slots: ProposedSlot[],
  ) {
    const createdIds: string[] = [];
    let skippedAlreadyExistsCount = 0;

    for (const slot of slots) {
      const conflicts = await this.conflicts.findConflictsForSlots(studioId, [slot]);
      const { blocking } = this.conflicts.partitionConflicts(conflicts);
      const isDuplicate = blocking.some((c) => c.kind === 'DUPLICATE_OCCURRENCE');
      if (isDuplicate) {
        skippedAlreadyExistsCount++;
        continue;
      }

      const outcome = await insertScheduledOccurrenceOrSkip(tx, {
        studioId,
        classTemplateId: slot.classTemplateId,
        instructorId: slot.instructorId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        capacity: slot.capacity,
        scheduleTemplateId: null,
        exceptionKind: null,
      });

      if (outcome.outcome === 'created') {
        createdIds.push(outcome.id);
      } else {
        skippedAlreadyExistsCount++;
      }
    }

    return { createdIds, skippedAlreadyExistsCount };
  }

  private async buildDuplicateWeekSlots(
    studioId: string,
    timezone: string,
    sourceWeekStart: string,
    targetWeekStarts: string[],
  ): Promise<ProposedSlot[]> {
    const sourceEnd = addDaysToDateKey(sourceWeekStart, 7);
    const rangeStart = studioLocalDateKeyToUtcAnchor(sourceWeekStart, timezone);
    const rangeEnd = studioLocalDateKeyToUtcAnchor(sourceEnd, timezone);

    const sources = await this.prisma.scheduledClass.findMany({
      where: {
        studioId,
        status: ClassStatus.SCHEDULED,
        startsAt: { gte: rangeStart, lt: rangeEnd },
        classTemplate: { deletedAt: null },
      },
      select: {
        id: true,
        classTemplateId: true,
        instructorId: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
      },
    });

    const slots: ProposedSlot[] = [];
    for (const targetWeekStart of targetWeekStarts) {
      for (const src of sources) {
        const sourceDayKey = getStudioLocalDateKey(src.startsAt, timezone);
        const dayOffset = this.daysBetweenDateKeys(sourceWeekStart, sourceDayKey);
        const targetDayKey = addDaysToDateKey(targetWeekStart, dayOffset);
        const time = getStudioLocalHHmm(src.startsAt, timezone);
        const startsAt = studioLocalTimeToUtc(targetDayKey, time, timezone);
        const durationMs = src.endsAt.getTime() - src.startsAt.getTime();
        const endsAt = new Date(startsAt.getTime() + durationMs);

        slots.push({
          classTemplateId: src.classTemplateId,
          instructorId: src.instructorId,
          startsAt,
          endsAt,
          capacity: src.capacity,
          sourceScheduledClassId: src.id,
          localDateKey: targetDayKey,
        });
      }
    }
    return slots;
  }

  private buildDuplicateClassSlot(
    source: {
      classTemplateId: string;
      instructorId: string | null;
      capacity: number;
      startsAt: Date;
      endsAt: Date;
    },
    dto: DuplicateClassDto,
    timezone: string,
  ): ProposedSlot {
    const startsAt = studioLocalTimeToUtc(
      dto.localStart.date,
      dto.localStart.time,
      timezone,
    );
    let endsAt: Date;
    if (dto.localEnd) {
      endsAt = studioLocalTimeToUtc(dto.localEnd.date, dto.localEnd.time, timezone);
    } else {
      const durationMs = source.endsAt.getTime() - source.startsAt.getTime();
      endsAt = new Date(startsAt.getTime() + durationMs);
    }
    return {
      classTemplateId: source.classTemplateId,
      instructorId: dto.instructorId !== undefined ? dto.instructorId : source.instructorId,
      startsAt,
      endsAt,
      capacity: dto.capacity ?? source.capacity,
      localDateKey: dto.localStart.date,
    };
  }

  private async buildBulkConflicts(
    studioId: string,
    rows: Awaited<ReturnType<typeof this.loadBulkTargets>>,
    dto: BulkScheduleOperationDto,
  ) {
    const slots: OccurrenceSlot[] = [];
    const conflicts: Awaited<
      ReturnType<ScheduleConflictsService['findConflictsForSlots']>
    > = [];

    for (const row of rows) {
      if (dto.operation === BulkScheduleOperation.MOVE_TIME) {
        const deltaMs = (dto.timeDeltaMinutes ?? 0) * 60_000;
        slots.push({
          classTemplateId: row.classTemplateId,
          instructorId: row.instructorId,
          startsAt: new Date(row.startsAt.getTime() + deltaMs),
          endsAt: new Date(row.endsAt.getTime() + deltaMs),
          capacity: row.capacity,
          excludeScheduledClassId: row.id,
        });
      } else if (dto.operation === BulkScheduleOperation.CHANGE_INSTRUCTOR) {
        slots.push({
          classTemplateId: row.classTemplateId,
          instructorId: dto.instructorId ?? null,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          capacity: row.capacity,
          excludeScheduledClassId: row.id,
        });
      } else if (
        dto.operation === BulkScheduleOperation.CHANGE_CAPACITY &&
        dto.capacity! < row._count.bookings
      ) {
        conflicts.push({
          kind: 'CAPACITY_BELOW_BOOKINGS',
          severity: 'BLOCKING',
          message: `Class has ${row._count.bookings} confirmed booking(s); capacity ${dto.capacity} is too low.`,
          scheduledClassId: row.id,
        });
      }
    }

    if (slots.length) {
      conflicts.push(...(await this.conflicts.findConflictsForSlots(studioId, slots)));
    }

    return conflicts;
  }

  private resolveTargetWeeks(dto: DuplicateWeekDto): string[] {
    if (dto.targetWeekStarts?.length) {
      return dto.targetWeekStarts;
    }
    if (dto.repeatWeeks) {
      const out: string[] = [];
      let cursor = addDaysToDateKey(dto.sourceWeekStart, 7);
      for (let i = 0; i < dto.repeatWeeks; i++) {
        out.push(cursor);
        cursor = addDaysToDateKey(cursor, 7);
      }
      return out;
    }
    throw new BadRequestException('Provide targetWeekStarts or repeatWeeks.');
  }

  private daysBetweenDateKeys(fromKey: string, toKey: string): number {
    const [fy, fm, fd] = fromKey.split('-').map(Number);
    const [ty, tm, td] = toKey.split('-').map(Number);
    const fromMs = Date.UTC(fy!, fm! - 1, fd!);
    const toMs = Date.UTC(ty!, tm! - 1, td!);
    return Math.round((toMs - fromMs) / 86_400_000);
  }

  private async loadBulkTargets(studioId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    const rows = await this.prisma.scheduledClass.findMany({
      where: {
        id: { in: unique },
        studioId,
        status: ClassStatus.SCHEDULED,
        classTemplate: { deletedAt: null },
      },
      select: {
        id: true,
        classTemplateId: true,
        instructorId: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        scheduleTemplateId: true,
        _count: {
          select: {
            bookings: { where: { status: BookingStatus.CONFIRMED } },
          },
        },
      },
    });
    if (rows.length !== unique.length) {
      throw new NotFoundException('One or more scheduled classes were not found.');
    }
    return rows;
  }

  private async countReservationImpact(ids: string[]) {
    if (ids.length === 0) {
      return { classesWithReservations: 0, totalReservations: 0 };
    }
    const rows = await this.prisma.scheduledClass.findMany({
      where: { id: { in: ids } },
      select: {
        _count: {
          select: {
            bookings: { where: { status: BookingStatus.CONFIRMED } },
          },
        },
      },
    });
    let classesWithReservations = 0;
    let totalReservations = 0;
    for (const r of rows) {
      const n = r._count.bookings;
      if (n > 0) {
        classesWithReservations++;
        totalReservations += n;
      }
    }
    return { classesWithReservations, totalReservations };
  }

  private bulkRequiresReservationConfirm(dto: BulkScheduleOperationDto): boolean {
    return (
      dto.operation === BulkScheduleOperation.MOVE_TIME ||
      dto.operation === BulkScheduleOperation.CANCEL
    );
  }

  private buildBulkDuplicateSlots(
    rows: Awaited<ReturnType<typeof this.loadBulkTargets>>,
    timezone: string,
    weekOffsetWeeks: number,
  ): ProposedSlot[] {
    const deltaMs = weekOffsetWeeks * 7 * 86_400_000;
    return rows.map((row) => {
      const startsAt = new Date(row.startsAt.getTime() + deltaMs);
      const endsAt = new Date(row.endsAt.getTime() + deltaMs);
      return {
        classTemplateId: row.classTemplateId,
        instructorId: row.instructorId,
        startsAt,
        endsAt,
        capacity: row.capacity,
        localDateKey: getStudioLocalDateKey(startsAt, timezone),
        sourceScheduledClassId: row.id,
      };
    });
  }

  private bulkAuditAction(op: BulkScheduleOperation): string {
    switch (op) {
      case BulkScheduleOperation.CHANGE_INSTRUCTOR:
        return 'SCHEDULE_BULK_INSTRUCTOR_CHANGED';
      case BulkScheduleOperation.CHANGE_CAPACITY:
        return 'SCHEDULE_BULK_CAPACITY_CHANGED';
      case BulkScheduleOperation.MOVE_TIME:
        return 'SCHEDULE_BULK_TIME_CHANGED';
      case BulkScheduleOperation.CANCEL:
        return 'SCHEDULE_BULK_CANCELLED';
      case BulkScheduleOperation.DUPLICATE:
        return 'SCHEDULE_BULK_DUPLICATED';
      default:
        return 'SCHEDULE_BULK_OPERATION';
    }
  }

  private assertPreviewAllowed(preview: ScheduleOperationResult, confirmWarnings?: boolean) {
    if (preview.blockedCount > 0) {
      throw new ConflictException({
        message: 'Blocking conflicts prevent this operation.',
        conflicts: preview.conflicts.filter((c) => c.severity === 'BLOCKING'),
      });
    }
    if (preview.warningCount > 0 && !confirmWarnings) {
      throw new BadRequestException({
        message: 'Warnings require confirmation.',
        conflicts: preview.conflicts.filter((c) => c.severity === 'WARNING'),
        requiresConfirmation: true,
      });
    }
  }

  private async findIdempotentReplayTx(
    tx: Prisma.TransactionClient,
    studioId: string,
    action: string,
    idempotencyKey?: string,
  ): Promise<ScheduleOperationResult | null> {
    if (!idempotencyKey) return null;
    const since = new Date(Date.now() - 60 * 60_000);
    const rows = await tx.auditLog.findMany({
      where: { studioId, action, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    for (const row of rows) {
      const meta = row.metadata as Record<string, unknown> | null;
      if (meta?.idempotencyKey === idempotencyKey && meta.result) {
        return { ...(meta.result as ScheduleOperationResult), idempotentReplay: true };
      }
    }
    return null;
  }

  private async requireStudio(studioId: string) {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { id: true, timezone: true },
    });
    if (!studio) throw new NotFoundException('Studio not found');
    return studio;
  }

  private async requireScheduledClass(studioId: string, id: string) {
    const row = await this.prisma.scheduledClass.findFirst({
      where: { id, studioId, classTemplate: { deletedAt: null } },
      select: {
        id: true,
        classTemplateId: true,
        instructorId: true,
        capacity: true,
        startsAt: true,
        endsAt: true,
        status: true,
      },
    });
    if (!row) throw new NotFoundException('Scheduled class not found');
    if (row.status !== ClassStatus.SCHEDULED) {
      throw new BadRequestException('Only scheduled classes can be duplicated.');
    }
    return row;
  }
}
