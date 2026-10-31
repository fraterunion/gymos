import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, ClassStatus, Prisma, WaitlistStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  getDayOfWeekFromDateKey,
  getStudioLocalDateKey,
  getStudioLocalHHmm,
} from '../common/date/studio-local-date';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import { cascadeClassCancellationInTx } from './cascade-class-cancellation';
import {
  assertNotProtected,
  cancellableClassWhere,
  protectedClassReason,
  type ProtectedReason,
} from './class-cancellation-guard';
import type { MatchingDatesCancelExecuteDto, MatchingDatesCancelPreviewDto } from './dto/schedule-operations.dto';
import { acquireOperationAdvisoryLock } from './schedule-occurrence-concurrency';
import { matchingDatesCancelReason } from './schedule-matching-dates-tombstone';

/**
 * Cancels every future SCHEDULED occurrence that is not on a recurring series and shares the
 * source class's studio, class template, studio-local weekday and studio-local start time.
 * Instructor is part of the match unless the caller explicitly includes other instructors.
 * Class name is never a match key.
 *
 * The date-range endpoint cannot express this: a template filter would also cancel other
 * times of the same class. Cancelled rows stay as tombstones (status + reason). The generator
 * dedups against every status, and week copy refuses to reactivate this reason.
 * Creating the same slot again by hand still reactivates an empty tombstone; this operation
 * does not install a permanent "never schedule this time" rule.
 */

export const MATCHING_DATES_CANCEL_AUDIT_ACTION = 'SCHEDULE_MATCHING_DATES_CANCEL';
export const MATCHING_DATES_CANCEL_MAX_CLASSES = 2000;
export const MATCHING_DATES_STALE_PREVIEW_MESSAGE =
  'Las fechas cambiaron desde la vista previa (nuevas reservas, check-ins o cambios de horario). Genera una nueva vista previa antes de cancelar.';
export const MATCHING_DATES_SOURCE_SERIES_MESSAGE =
  'Esta clase pertenece a una serie recurrente. Cancélala desde la serie.';
export const MATCHING_DATES_SOURCE_INELIGIBLE_MESSAGE =
  'Solo una clase futura programada puede originar esta cancelación.';

export type MatchingDatesExcludedReason = 'OTHER_INSTRUCTOR' | 'SERIES';

export type MatchingDatesClassItem = {
  id: string;
  startsAt: string;
  endsAt: string;
  localDate: string;
  localTime: string;
  weekday: number;
  classTemplateId: string;
  className: string;
  instructorId: string | null;
  instructorName: string | null;
  bookings: number;
  waitlist: number;
};

export type MatchingDatesProtectedItem = MatchingDatesClassItem & {
  reason: ProtectedReason;
  attendances: number;
};

export type MatchingDatesExcludedItem = MatchingDatesClassItem & {
  reason: MatchingDatesExcludedReason;
};

export type MatchingDatesPreview = {
  timezone: string;
  sourceClassId: string;
  classTemplateId: string;
  className: string;
  weekday: number;
  localTime: string;
  instructorId: string | null;
  instructorName: string | null;
  includeOtherInstructors: boolean;
  classes: MatchingDatesClassItem[];
  protectedClasses: MatchingDatesProtectedItem[];
  excludedClasses: MatchingDatesExcludedItem[];
  alreadyCancelledCount: number;
  totals: { classes: number; bookings: number; waitlist: number; protected: number; excluded: number };
  previewFingerprint: string;
};

export type MatchingDatesResult = {
  cancelledCount: number;
  cancelledBookingCount: number;
  expiredWaitlistCount: number;
  cancelledClassIds: string[];
  protectedClasses: MatchingDatesProtectedItem[];
  excludedClasses: MatchingDatesExcludedItem[];
  cancelReason: string | null;
  idempotentReplay?: boolean;
};

type SlotRow = Prisma.ScheduledClassGetPayload<{
  select: {
    id: true;
    startsAt: true;
    endsAt: true;
    status: true;
    classTemplateId: true;
    instructorId: true;
    scheduleTemplateId: true;
    classTemplate: { select: { name: true } };
    instructor: { select: { firstName: true; lastName: true } };
    _count: { select: { bookings: true; waitlist: true; attendances: true } };
  };
}>;

type SourceClass = {
  id: string;
  classTemplateId: string;
  instructorId: string | null;
  startsAt: Date;
  status: ClassStatus;
  scheduleTemplateId: string | null;
  attendanceCount: number;
  classTemplate: { name: string };
  instructor: { firstName: string; lastName: string } | null;
};

@Injectable()
export class ScheduleMatchingDatesCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async preview(
    studioId: string,
    dto: MatchingDatesCancelPreviewDto,
    now: Date = new Date(),
  ): Promise<MatchingDatesPreview> {
    const studio = await this.requireStudio(studioId);
    const source = await this.requireSource(this.prisma, studioId, dto.scheduledClassId);
    this.assertEligibleSource(source, now);
    return this.buildPreview(this.prisma, studioId, studio.timezone, source, dto.includeOtherInstructors === true, now);
  }

  async execute(
    studioId: string,
    dto: MatchingDatesCancelExecuteDto,
    actorUserId: string,
  ): Promise<MatchingDatesResult> {
    if (dto.confirm !== true) {
      throw new BadRequestException('Confirma explícitamente la cancelación antes de continuar.');
    }
    const studio = await this.requireStudio(studioId);
    await this.requireSource(this.prisma, studioId, dto.scheduledClassId);
    const includeOtherInstructors = dto.includeOtherInstructors === true;
    const staffReason = dto.cancelReason?.trim() || null;

    return this.prisma.$transaction(
      async (tx) => {
        await acquireOperationAdvisoryLock(tx, studioId, MATCHING_DATES_CANCEL_AUDIT_ACTION, dto.idempotencyKey);
        const replay = await this.findReplay(tx, studioId, dto);
        if (replay) return replay;

        const now = new Date();
        const source = await this.requireSource(tx, studioId, dto.scheduledClassId);
        this.assertEligibleSource(source, now);
        const preview = await this.buildPreview(tx, studioId, studio.timezone, source, includeOtherInstructors, now);
        if (preview.previewFingerprint !== dto.previewFingerprint) {
          throw new ConflictException(MATCHING_DATES_STALE_PREVIEW_MESSAGE);
        }
        const ids = preview.classes.map((row) => row.id);
        const storedReason = matchingDatesCancelReason(staffReason);
        if (ids.length > 0) {
          const updated = await tx.scheduledClass.updateMany({
            where: {
              id: { in: ids },
              studioId,
              classTemplateId: source.classTemplateId,
              scheduleTemplateId: null,
              status: ClassStatus.SCHEDULED,
              ...cancellableClassWhere(now),
            },
            data: { status: ClassStatus.CANCELLED, cancelReason: storedReason },
          });
          if (updated.count !== ids.length) {
            throw new ConflictException(MATCHING_DATES_STALE_PREVIEW_MESSAGE);
          }
        }
        const cascade = await cascadeClassCancellationInTx(tx, { studioId, scheduledClassIds: ids, now });
        const result: MatchingDatesResult = {
          cancelledCount: ids.length,
          cancelledBookingCount: cascade.cancelledBookingCount,
          expiredWaitlistCount: cascade.expiredWaitlistCount,
          cancelledClassIds: ids,
          protectedClasses: preview.protectedClasses,
          excludedClasses: preview.excludedClasses,
          cancelReason: storedReason,
        };
        await this.audit.log(
          {
            studioId,
            actorUserId,
            action: MATCHING_DATES_CANCEL_AUDIT_ACTION,
            entityType: 'ScheduleOperation',
            entityId: source.id,
            metadata: {
              idempotencyKey: dto.idempotencyKey,
              sourceClassId: source.id,
              classTemplateId: source.classTemplateId,
              weekday: preview.weekday,
              localTime: preview.localTime,
              instructorId: source.instructorId,
              includeOtherInstructors,
              timezone: studio.timezone,
              cancelReason: storedReason,
              previewFingerprint: dto.previewFingerprint,
              cancelledCount: result.cancelledCount,
              cancelledBookingCount: result.cancelledBookingCount,
              expiredWaitlistCount: result.expiredWaitlistCount,
              protectedCount: preview.protectedClasses.length,
              excludedCount: preview.excludedClasses.length,
              result: result as unknown as Prisma.InputJsonValue,
            },
          },
          tx,
        );
        return result;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  private async buildPreview(
    db: Prisma.TransactionClient | PrismaService,
    studioId: string,
    timezone: string,
    source: SourceClass,
    includeOtherInstructors: boolean,
    now: Date,
  ): Promise<MatchingDatesPreview> {
    const slot = localSlot(source.startsAt, timezone);
    const rows: SlotRow[] = await db.scheduledClass.findMany({
      where: {
        studioId,
        classTemplateId: source.classTemplateId,
        startsAt: { gt: now },
        status: { in: [ClassStatus.SCHEDULED, ClassStatus.COMPLETED, ClassStatus.CANCELLED] },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        status: true,
        classTemplateId: true,
        instructorId: true,
        scheduleTemplateId: true,
        classTemplate: { select: { name: true } },
        instructor: { select: { firstName: true, lastName: true } },
        _count: {
          select: {
            bookings: { where: { status: BookingStatus.CONFIRMED } },
            waitlist: { where: { status: WaitlistStatus.WAITING } },
            attendances: true,
          },
        },
      },
    });

    const classes: MatchingDatesClassItem[] = [];
    const protectedClasses: MatchingDatesProtectedItem[] = [];
    const excludedClasses: MatchingDatesExcludedItem[] = [];
    let alreadyCancelledCount = 0;

    for (const row of rows) {
      const rowSlot = localSlot(row.startsAt, timezone);
      if (rowSlot.weekday !== slot.weekday || rowSlot.localTime !== slot.localTime) continue;
      const item = this.toItem(row, timezone, rowSlot.weekday);
      if (row.status === ClassStatus.CANCELLED) {
        alreadyCancelledCount += 1;
        continue;
      }
      if (row.scheduleTemplateId != null) {
        excludedClasses.push({ ...item, reason: 'SERIES' });
        continue;
      }
      if (!includeOtherInstructors && row.instructorId !== source.instructorId) {
        excludedClasses.push({ ...item, reason: 'OTHER_INSTRUCTOR' });
        continue;
      }
      const reason = protectedClassReason(
        { startsAt: row.startsAt, status: row.status, attendanceCount: row._count.attendances },
        now,
      );
      if (reason) protectedClasses.push({ ...item, reason, attendances: row._count.attendances });
      else classes.push(item);
    }

    if (classes.length > MATCHING_DATES_CANCEL_MAX_CLASSES) {
      throw new BadRequestException(
        `Hay ${classes.length} fechas que coinciden; el máximo por operación es ${MATCHING_DATES_CANCEL_MAX_CLASSES}.`,
      );
    }

    const instructorName = instructorLabel(source.instructor);
    return {
      timezone,
      sourceClassId: source.id,
      classTemplateId: source.classTemplateId,
      className: source.classTemplate.name,
      weekday: slot.weekday,
      localTime: slot.localTime,
      instructorId: source.instructorId,
      instructorName,
      includeOtherInstructors,
      classes,
      protectedClasses,
      excludedClasses,
      alreadyCancelledCount,
      totals: {
        classes: classes.length,
        bookings: classes.reduce((sum, row) => sum + row.bookings, 0),
        waitlist: classes.reduce((sum, row) => sum + row.waitlist, 0),
        protected: protectedClasses.length,
        excluded: excludedClasses.length,
      },
      previewFingerprint: fingerprint(classes, protectedClasses, excludedClasses),
    };
  }

  private toItem(row: SlotRow, timezone: string, weekday: number): MatchingDatesClassItem {
    return {
      id: row.id,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      localDate: getStudioLocalDateKey(row.startsAt, timezone),
      localTime: getStudioLocalHHmm(row.startsAt, timezone),
      weekday,
      classTemplateId: row.classTemplateId,
      className: row.classTemplate.name,
      instructorId: row.instructorId,
      instructorName: instructorLabel(row.instructor),
      bookings: row._count.bookings,
      waitlist: row._count.waitlist,
    };
  }

  private async findReplay(
    tx: Prisma.TransactionClient,
    studioId: string,
    dto: MatchingDatesCancelExecuteDto,
  ): Promise<MatchingDatesResult | null> {
    const row = await tx.auditLog.findFirst({
      where: {
        studioId,
        action: MATCHING_DATES_CANCEL_AUDIT_ACTION,
        metadata: { path: ['idempotencyKey'], equals: dto.idempotencyKey },
      },
      orderBy: { createdAt: 'asc' },
    });
    const meta = row?.metadata as { result?: MatchingDatesResult; previewFingerprint?: string } | null | undefined;
    if (!meta?.result) return null;
    if (meta.previewFingerprint !== dto.previewFingerprint) {
      throw new ConflictException('Esta clave de confirmación ya se usó para otra cancelación de fechas.');
    }
    return { ...meta.result, idempotentReplay: true };
  }

  private async requireStudio(studioId: string) {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { id: true, timezone: true },
    });
    if (!studio) throw new NotFoundException('Studio not found');
    return studio;
  }

  /** The opened class must itself be a future unlinked SCHEDULED session. Replay is decided before this. */
  private assertEligibleSource(source: SourceClass, now: Date): void {
    if (source.scheduleTemplateId != null) {
      throw new BadRequestException(MATCHING_DATES_SOURCE_SERIES_MESSAGE);
    }
    if (source.status !== ClassStatus.SCHEDULED) {
      throw new BadRequestException(MATCHING_DATES_SOURCE_INELIGIBLE_MESSAGE);
    }
    assertNotProtected(
      protectedClassReason(
        { startsAt: source.startsAt, status: source.status, attendanceCount: source.attendanceCount },
        now,
      ),
    );
  }

  private async requireSource(
    db: Prisma.TransactionClient | PrismaService,
    studioId: string,
    scheduledClassId: string,
  ): Promise<SourceClass> {
    const source = await db.scheduledClass.findFirst({
      where: { id: scheduledClassId, studioId },
      select: {
        id: true,
        classTemplateId: true,
        instructorId: true,
        startsAt: true,
        status: true,
        scheduleTemplateId: true,
        classTemplate: { select: { name: true } },
        instructor: { select: { firstName: true, lastName: true } },
        _count: { select: { attendances: true } },
      },
    });
    if (!source) throw new NotFoundException('Class not found');
    return {
      id: source.id,
      classTemplateId: source.classTemplateId,
      instructorId: source.instructorId,
      startsAt: source.startsAt,
      status: source.status,
      scheduleTemplateId: source.scheduleTemplateId,
      attendanceCount: source._count.attendances,
      classTemplate: source.classTemplate,
      instructor: source.instructor,
    };
  }
}

export function localSlot(startsAt: Date, timezone: string): { weekday: number; localTime: string; localDate: string } {
  const localDate = getStudioLocalDateKey(startsAt, timezone);
  return {
    localDate,
    weekday: getDayOfWeekFromDateKey(localDate),
    localTime: getStudioLocalHHmm(startsAt, timezone),
  };
}

function instructorLabel(instructor: { firstName: string; lastName: string } | null): string | null {
  if (!instructor) return null;
  const name = `${instructor.firstName} ${instructor.lastName}`.trim();
  return name || null;
}

function fingerprint(
  classes: MatchingDatesClassItem[],
  protectedClasses: MatchingDatesProtectedItem[],
  excludedClasses: MatchingDatesExcludedItem[],
): string {
  const lines = [
    ...classes.map((row) => `C|${row.id}|${row.startsAt}|${row.instructorId ?? ''}|${row.bookings}|${row.waitlist}`),
    ...protectedClasses.map((row) => `P|${row.id}|${row.reason}`),
    ...excludedClasses.map((row) => `X|${row.id}|${row.reason}|${row.instructorId ?? ''}`),
  ];
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}
