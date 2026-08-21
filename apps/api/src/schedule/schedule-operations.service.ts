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
  WaitlistStatus,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
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
import { acquireOperationAdvisoryLock, acquireWeekReconciliationLocks } from './schedule-occurrence-concurrency';
import { insertScheduledOccurrenceOrSkip } from './schedule-occurrence-insert';
import {
  buildPreviewResult,
  emptyOperationResult,
  type ScheduleOperationResult,
  type ScheduleReconciliationItem,
} from './schedule-operation-result';
import {
  applyWeekReconciliationPlanBatched,
  boundedAuditClassIds,
  WEEK_RECONCILIATION_TX_OPTIONS,
} from './schedule-week-reconciliation-apply';
import {
  buildWeekReconciliationPlan,
  planToOperationCounts,
  type DesiredWeekSlot,
  type ExistingWeekRow,
  type WeekReconciliationPlan,
} from './schedule-week-reconciliation';

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
    const { plan, conflicts, existingRows, instructorNames } =
      await this.buildDuplicateWeekReconciliation(
        studioId,
        studio.timezone,
        dto.sourceWeekStart,
        targetWeeks,
      );
    return this.reconciliationPlanToResult(
      plan,
      conflicts,
      studio.timezone,
      existingRows,
      instructorNames,
    );
  }

  async executeDuplicateWeek(
    studioId: string,
    dto: DuplicateWeekDto,
    actorUserId: string,
  ): Promise<ScheduleOperationResult> {
    const action = 'SCHEDULE_WEEK_DUPLICATED';
    const targetWeeks = this.resolveTargetWeeks(dto);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await acquireWeekReconciliationLocks(tx, studioId, targetWeeks);

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
        const { plan, conflicts, existingRows, instructorNames } =
          await this.buildDuplicateWeekReconciliation(
            studioId,
            studio.timezone,
            dto.sourceWeekStart,
            targetWeeks,
            tx,
          );
        const preview = this.reconciliationPlanToResult(
          plan,
          conflicts,
          studio.timezone,
          existingRows,
          instructorNames,
        );
        this.assertWeekReconciliationAllowed(preview, dto);

        const applied = await applyWeekReconciliationPlanBatched(tx, studioId, plan);

        const result = emptyOperationResult({
          proposedCount: preview.proposedCount,
          createdCount: applied.createdCount,
          updatedCount: applied.updatedCount,
          removedCount: applied.removedCount,
          cancelledCount: applied.removedCount,
          reusedCount: applied.reusedCount,
          reviewCount: preview.reviewCount,
          blockedCount: preview.blockedCount,
          warningCount: preview.warningCount,
          affectedReservationCount: preview.affectedReservationCount,
          conflicts: preview.conflicts,
          affectedClassIds: applied.affectedClassIds,
        });

        const auditIds = boundedAuditClassIds(applied.affectedClassIds);
        const compactResult: ScheduleOperationResult = {
          ...result,
          conflicts: [],
        };
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
              proposedCount: preview.proposedCount,
              createdCount: result.createdCount,
              reusedCount: result.reusedCount,
              updatedCount: result.updatedCount,
              removedCount: result.removedCount,
              cancelledCount: result.cancelledCount,
              reviewCount: result.reviewCount,
              blockedCount: result.blockedCount,
              affectedReservationCount: result.affectedReservationCount,
              ...auditIds,
              result: compactResult,
            },
          },
          dto.idempotencyKey ? tx : undefined,
        );

        return result;
      }, WEEK_RECONCILIATION_TX_OPTIONS);
    } catch (error) {
      this.rethrowWeekReconciliationExecuteError(error);
    }
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

  private async buildDuplicateWeekReconciliation(
    studioId: string,
    timezone: string,
    sourceWeekStart: string,
    targetWeekStarts: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<{
    plan: WeekReconciliationPlan;
    conflicts: Awaited<ReturnType<ScheduleConflictsService['findConflictsForSlots']>>;
    existingRows: ExistingWeekRow[];
    instructorNames: Map<string, string>;
  }> {
    const db = tx ?? this.prisma;
    const desiredSlots = await this.buildDuplicateWeekSlots(
      studioId,
      timezone,
      sourceWeekStart,
      targetWeekStarts,
      db,
    );
    const existingRows = await this.loadTargetWeekExistingRows(
      studioId,
      timezone,
      targetWeekStarts,
      db,
    );
    const instructorNames = await this.loadInstructorNameMap(
      studioId,
      desiredSlots,
      existingRows,
      db,
    );
    const plan = buildWeekReconciliationPlan(desiredSlots, existingRows);
    const conflictSlots: OccurrenceSlot[] = [];
    for (const action of plan.actions) {
      if (action.kind === 'CREATE' && action.slot) {
        conflictSlots.push(action.slot);
      }
      if (action.kind === 'UPDATE' && action.slot && action.existingId) {
        conflictSlots.push({
          ...action.slot,
          excludeScheduledClassId: action.existingId,
        });
      }
    }
    const conflicts =
      conflictSlots.length > 0
        ? await this.conflicts.findConflictsForSlots(studioId, conflictSlots)
        : [];
    return { plan, conflicts, existingRows, instructorNames };
  }

  private async loadInstructorNameMap(
    studioId: string,
    desiredSlots: DesiredWeekSlot[],
    existingRows: ExistingWeekRow[],
    db: Prisma.TransactionClient | PrismaService,
  ): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const slot of desiredSlots) {
      if (slot.instructorId) ids.add(slot.instructorId);
    }
    for (const row of existingRows) {
      if (row.instructorId) ids.add(row.instructorId);
    }
    if (ids.size === 0) return new Map();

    const rows = await db.user.findMany({
      where: {
        id: { in: [...ids] },
        studioMemberships: { some: { studioId } },
      },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(
      rows.map((r) => [r.id, `${r.firstName} ${r.lastName}`.trim()]),
    );
  }

  private async loadTargetWeekExistingRows(
    studioId: string,
    timezone: string,
    targetWeekStarts: string[],
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<ExistingWeekRow[]> {
    if (targetWeekStarts.length === 0) return [];
    const ranges = targetWeekStarts.map((weekStart) => ({
      gte: studioLocalDateKeyToUtcAnchor(weekStart, timezone),
      lt: studioLocalDateKeyToUtcAnchor(addDaysToDateKey(weekStart, 7), timezone),
    }));
    const rows = await db.scheduledClass.findMany({
      where: {
        studioId,
        OR: ranges.map((r) => ({ startsAt: r })),
        classTemplate: { deletedAt: null },
      },
      select: {
        id: true,
        classTemplateId: true,
        instructorId: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        status: true,
        scheduleTemplateId: true,
        exceptionKind: true,
        classTemplate: { select: { name: true } },
        instructor: { select: { firstName: true, lastName: true } },
        _count: {
          select: {
            bookings: { where: { status: BookingStatus.CONFIRMED } },
            attendances: true,
            waitlist: { where: { status: WaitlistStatus.WAITING } },
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      classTemplateId: row.classTemplateId,
      instructorId: row.instructorId,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      capacity: row.capacity,
      status: row.status,
      scheduleTemplateId: row.scheduleTemplateId,
      exceptionKind: row.exceptionKind,
      bookingCount: row._count.bookings,
      attendanceCount: row._count.attendances,
      waitlistCount: row._count.waitlist,
      classTemplateName: row.classTemplate.name,
      instructorFirstName: row.instructor?.firstName ?? null,
      instructorLastName: row.instructor?.lastName ?? null,
    }));
  }

  private reconciliationPlanToResult(
    plan: WeekReconciliationPlan,
    conflicts: Awaited<ReturnType<ScheduleConflictsService['findConflictsForSlots']>>,
    timezone: string,
    existingRows: ExistingWeekRow[],
    instructorNames: Map<string, string>,
  ): ScheduleOperationResult {
    const hardBlocks = conflicts.filter(
      (c) => c.severity === 'BLOCKING' && c.kind !== 'DUPLICATE_OCCURRENCE',
    );
    const warnings = conflicts.filter((c) => c.severity === 'WARNING');
    const counts = planToOperationCounts(plan);
    const existingById = new Map(existingRows.map((row) => [row.id, row]));
    const reconciliationItems: ScheduleReconciliationItem[] = plan.actions
      .filter((a) => a.kind !== 'REUSE')
      .map((action) => {
        const existing = action.existingId ? existingById.get(action.existingId) : undefined;
        const classTemplateName =
          action.slot?.classTemplateName ?? existing?.classTemplateName;
        const localDateKey = action.slot?.localDateKey;
        const startTime = action.slot
          ? getStudioLocalHHmm(action.slot.startsAt, timezone)
          : existing
            ? getStudioLocalHHmm(existing.startsAt, timezone)
            : undefined;
        const dateLabel = localDateKey
          ? this.formatReconciliationDateLabel(localDateKey, timezone)
          : existing
            ? this.formatReconciliationDateLabel(
                getStudioLocalDateKey(existing.startsAt, timezone),
                timezone,
              )
            : undefined;
        const timeLabel = startTime ? this.formatReconciliationTimeLabel(startTime) : undefined;
        const detail = this.buildReconciliationItemDetail(
          action,
          existing,
          instructorNames,
        );
        return {
          kind: action.kind,
          classTemplateName,
          localDateKey,
          startTime,
          dateLabel,
          timeLabel,
          actionLabel: this.reconciliationActionLabel(action.kind, action.bookingCount),
          detail,
          bookingCount: action.bookingCount,
          message: action.message,
        };
      });

    return emptyOperationResult({
      proposedCount: counts.proposedCount,
      createdCount: counts.createdCount,
      updatedCount: counts.updatedCount,
      cancelledCount: counts.cancelledCount,
      removedCount: counts.removedCount,
      reusedCount: counts.reusedCount,
      reviewCount: counts.reviewCount,
      blockedCount: counts.blockedCount + hardBlocks.length,
      warningCount: warnings.length,
      affectedReservationCount: counts.affectedReservationCount,
      conflicts: [
        ...conflicts.filter((c) => c.kind !== 'DUPLICATE_OCCURRENCE'),
      ],
      reconciliationItems,
    });
  }

  private assertWeekReconciliationAllowed(
    preview: ScheduleOperationResult,
    dto: DuplicateWeekDto,
  ) {
    const hardConflicts = preview.conflicts.filter((c) => c.severity === 'BLOCKING');
    if (preview.blockedCount > 0 || hardConflicts.length > 0) {
      throw new ConflictException({
        message:
          'Hay clases con reservaciones o asistencias que requieren revisión manual.',
        conflicts: hardConflicts,
      });
    }
    if (preview.reviewCount > 0) {
      throw new BadRequestException({
        message:
          'Hay clases con reservaciones o asistencias que requieren revisión manual.',
        reviewCount: preview.reviewCount,
        requiresConfirmation: true,
      });
    }
    if (preview.removedCount > 0 && !dto.confirmRemovals) {
      throw new BadRequestException({
        message: 'Hay clases adicionales que se retirarán. Confirma para continuar.',
        removedCount: preview.removedCount,
        requiresConfirmation: true,
      });
    }
    if (preview.warningCount > 0 && !dto.confirmWarnings) {
      throw new BadRequestException({
        message: 'Hay advertencias. Confirma para continuar.',
        conflicts: preview.conflicts.filter((c) => c.severity === 'WARNING'),
        requiresConfirmation: true,
      });
    }
  }

  private rethrowWeekReconciliationExecuteError(error: unknown): never {
    if (error instanceof ConflictException || error instanceof BadRequestException) {
      throw error;
    }
    if (error instanceof PrismaClientKnownRequestError) {
      if (error.code === 'P2028') {
        throw new ConflictException({
          message:
            'La operación tardó demasiado mientras se aplicaba el calendario. Revisa la vista previa e inténtalo de nuevo.',
          code: 'WEEK_RECONCILIATION_TIMEOUT',
        });
      }
      if (error.code === 'P2002') {
        throw new ConflictException({
          message:
            'La semana cambió mientras preparábamos la operación. Revisa la vista previa e inténtalo de nuevo.',
          code: 'WEEK_RECONCILIATION_CONFLICT',
        });
      }
    }
    throw error;
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
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<DesiredWeekSlot[]> {
    const sourceEnd = addDaysToDateKey(sourceWeekStart, 7);
    const rangeStart = studioLocalDateKeyToUtcAnchor(sourceWeekStart, timezone);
    const rangeEnd = studioLocalDateKeyToUtcAnchor(sourceEnd, timezone);

    const sources = await db.scheduledClass.findMany({
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
        classTemplate: { select: { name: true } },
      },
    });

    const slots: DesiredWeekSlot[] = [];
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
          classTemplateName: src.classTemplate.name,
          instructorId: src.instructorId,
          startsAt,
          endsAt,
          capacity: src.capacity,
          sourceScheduledClassId: src.id,
          localDateKey: targetDayKey,
          targetWeekStart,
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

  private formatReconciliationDateLabel(localDateKey: string, timezone: string): string {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(new Date(`${localDateKey}T12:00:00Z`));
  }

  private formatReconciliationTimeLabel(hhmm: string): string {
    const [hourStr, minuteStr] = hhmm.split(':');
    const hour = Number(hourStr);
    const minute = Number(minuteStr);
    const period = hour >= 12 ? 'p.m.' : 'a.m.';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return minute === 0 ? `${hour12} ${period}` : `${hour12}:${minuteStr} ${period}`;
  }

  private reconciliationActionLabel(
    kind: string,
    bookingCount?: number,
  ): string {
    switch (kind) {
      case 'CREATE':
        return 'Se creará';
      case 'UPDATE':
        return bookingCount && bookingCount > 0
          ? 'Se actualizará · reservaciones existentes'
          : 'Se actualizará';
      case 'REMOVE':
        return 'Se retirará';
      case 'REVIEW':
        return 'Requiere revisión';
      case 'BLOCK':
        return 'Bloqueada';
      default:
        return '';
    }
  }

  private buildReconciliationItemDetail(
    action: WeekReconciliationPlan['actions'][number],
    existing: ExistingWeekRow | undefined,
    instructorNames: Map<string, string>,
  ): string | undefined {
    if (action.message) return action.message;
    if (action.kind === 'UPDATE' && action.slot && existing) {
      const parts: string[] = [];
      if (existing.instructorId !== action.slot.instructorId) {
        const from = existing.instructorId
          ? instructorNames.get(existing.instructorId) ?? 'Sin instructor'
          : 'Sin instructor';
        const to = action.slot.instructorId
          ? instructorNames.get(action.slot.instructorId) ?? 'Sin instructor'
          : 'Sin instructor';
        parts.push(`Cambiará instructor: ${from} → ${to}`);
      }
      if (existing.capacity !== action.slot.capacity) {
        parts.push(`Capacidad: ${existing.capacity} → ${action.slot.capacity}`);
      }
      if (action.bookingCount && action.bookingCount > 0) {
        parts.push(`${action.bookingCount} reservación(es) existente(s)`);
      }
      return parts.length ? parts.join(' · ') : undefined;
    }
    if (action.kind === 'REVIEW' && action.bookingCount) {
      return `${action.bookingCount} reservación(es) existente(s)`;
    }
    if (action.kind === 'BLOCK' && action.attendanceCount) {
      return 'Tiene historial de asistencia';
    }
    return undefined;
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
