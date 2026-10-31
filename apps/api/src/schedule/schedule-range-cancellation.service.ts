import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, ClassStatus, Prisma, WaitlistStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  addDaysToDateKey,
  getStudioLocalDateKey,
  getStudioLocalHHmm,
  studioLocalDateKeyToUtcAnchor,
} from '../common/date/studio-local-date';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import { cascadeClassCancellationInTx } from './cascade-class-cancellation';
import { cancellableClassWhere, protectedClassReason, type ProtectedReason } from './class-cancellation-guard';
import type { RangeCancelExecuteDto, RangeCancelPreviewDto } from './dto/schedule-operations.dto';
import { acquireOperationAdvisoryLock } from './schedule-occurrence-concurrency';

/**
 * "Cancelar clases por rango de fechas": cancel every SCHEDULED class of a studio between two
 * studio-local dates (inclusive), across any number of weeks, optionally narrowed by instructor
 * and/or class type.
 *
 * Safety contract:
 *   - Preview lists exactly the classes that would be cancelled, with booking and waitlist counts,
 *     plus the protected classes in the range that will be kept (already started/completed, or a
 *     future class with an early check-in). Execution requires the preview fingerprint, so a range
 *     whose classes, bookings or waitlist changed since the preview is refused (409), never guessed.
 *   - Execution is one transaction: a conditional update that only touches classes that are still
 *     SCHEDULED, in the future and without attendance, followed by the shared cancellation cascade
 *     (confirmed bookings → CANCELLED, waiting entries → EXPIRED). If any target changed state in
 *     between, the whole operation rolls back: no partial destructive result.
 *   - Classes are soft-cancelled (status + reason); nothing is deleted. The cancelled rows keep
 *     their unique (studio, class type, start) slot, so the recurring generator — which dedups
 *     against rows of every status — cannot silently recreate them.
 *   - A per-studio idempotency key, serialized with an advisory lock, makes retries and double
 *     submissions return the first result. Every execution is written to the audit log.
 */

export const RANGE_CANCEL_AUDIT_ACTION = 'SCHEDULE_RANGE_CANCEL';
export const RANGE_CANCEL_MAX_DAYS = 184;
export const RANGE_CANCEL_MAX_CLASSES = 2000;

export const RANGE_CANCEL_STALE_PREVIEW_MESSAGE =
  'Las clases del rango cambiaron desde la vista previa (nuevas reservas, check-ins o cambios de horario). Genera una nueva vista previa antes de cancelar.';

export type RangeCancelClassItem = {
  id: string;
  startsAt: string;
  endsAt: string;
  localDate: string;
  localTime: string;
  classTemplateId: string;
  className: string;
  instructorId: string | null;
  instructorName: string | null;
  seriesId: string | null;
  bookings: number;
  waitlist: number;
};

export type RangeCancelProtectedItem = RangeCancelClassItem & {
  reason: ProtectedReason;
  attendances: number;
};

export type RangeCancelPreview = {
  timezone: string;
  fromDate: string;
  toDate: string;
  rangeStartUtc: string;
  rangeEndUtc: string;
  weekCount: number;
  classes: RangeCancelClassItem[];
  protectedClasses: RangeCancelProtectedItem[];
  alreadyCancelledCount: number;
  totals: { classes: number; bookings: number; waitlist: number; protected: number };
  previewFingerprint: string;
};

export type RangeCancelResult = {
  cancelledCount: number;
  cancelledBookingCount: number;
  expiredWaitlistCount: number;
  cancelledClassIds: string[];
  protectedClasses: RangeCancelProtectedItem[];
  fromDate: string;
  toDate: string;
  cancelReason: string | null;
  idempotentReplay?: boolean;
};

type RangeRow = Prisma.ScheduledClassGetPayload<{
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

/** UTC bounds [start, end) of the studio-local calendar days fromDate..toDate (inclusive). */
export function studioLocalRangeToUtc(fromDate: string, toDate: string, timezone: string) {
  return {
    start: studioLocalDateKeyToUtcAnchor(fromDate, timezone),
    end: studioLocalDateKeyToUtcAnchor(addDaysToDateKey(toDate, 1), timezone),
  };
}

const dateKeyUtcMs = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
};

/** Number of distinct Monday-started calendar weeks touched by fromDate..toDate. */
export function calendarWeekCount(fromDate: string, toDate: string): number {
  const monday = (key: string) => {
    const ms = dateKeyUtcMs(key);
    return ms - ((new Date(ms).getUTCDay() + 6) % 7) * 86_400_000;
  };
  return Math.round((monday(toDate) - monday(fromDate)) / (7 * 86_400_000)) + 1;
}

@Injectable()
export class ScheduleRangeCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async preview(studioId: string, dto: RangeCancelPreviewDto, now: Date = new Date()): Promise<RangeCancelPreview> {
    const studio = await this.requireStudio(studioId);
    const range = this.validateRange(dto, studio.timezone);
    await this.validateFilters(studioId, dto);
    return this.buildPreview(this.prisma, studioId, studio.timezone, dto, range, now);
  }

  async execute(
    studioId: string,
    dto: RangeCancelExecuteDto,
    actorUserId: string,
  ): Promise<RangeCancelResult> {
    if (dto.confirm !== true) {
      throw new BadRequestException('Confirma explícitamente la cancelación antes de continuar.');
    }
    const studio = await this.requireStudio(studioId);
    const range = this.validateRange(dto, studio.timezone);
    await this.validateFilters(studioId, dto);
    const cancelReason = dto.cancelReason?.trim() || null;

    return this.prisma.$transaction(
      async (tx) => {
        await acquireOperationAdvisoryLock(tx, studioId, RANGE_CANCEL_AUDIT_ACTION, dto.idempotencyKey);
        const replay = await this.findReplay(tx, studioId, dto);
        if (replay) return replay;

        const now = new Date();
        const preview = await this.buildPreview(tx, studioId, studio.timezone, dto, range, now);
        if (preview.previewFingerprint !== dto.previewFingerprint) {
          throw new ConflictException(RANGE_CANCEL_STALE_PREVIEW_MESSAGE);
        }
        const ids = preview.classes.map((c) => c.id);
        if (ids.length > 0) {
          // Re-asserted at write time: still SCHEDULED, still in the future, still without
          // attendance. Anything else means a class started or got a check-in after the
          // fingerprint check; throwing rolls the whole range back.
          const updated = await tx.scheduledClass.updateMany({
            where: {
              id: { in: ids },
              studioId,
              status: ClassStatus.SCHEDULED,
              ...cancellableClassWhere(now),
            },
            data: { status: ClassStatus.CANCELLED, cancelReason },
          });
          if (updated.count !== ids.length) {
            throw new ConflictException(RANGE_CANCEL_STALE_PREVIEW_MESSAGE);
          }
        }
        const cascade = await cascadeClassCancellationInTx(tx, { studioId, scheduledClassIds: ids, now });
        const result: RangeCancelResult = {
          cancelledCount: ids.length,
          cancelledBookingCount: cascade.cancelledBookingCount,
          expiredWaitlistCount: cascade.expiredWaitlistCount,
          cancelledClassIds: ids,
          protectedClasses: preview.protectedClasses,
          fromDate: dto.fromDate,
          toDate: dto.toDate,
          cancelReason,
        };
        await this.audit.log(
          {
            studioId,
            actorUserId,
            action: RANGE_CANCEL_AUDIT_ACTION,
            entityType: 'ScheduleOperation',
            metadata: {
              idempotencyKey: dto.idempotencyKey,
              fromDate: dto.fromDate,
              toDate: dto.toDate,
              timezone: studio.timezone,
              instructorIds: dto.instructorIds ?? [],
              classTemplateIds: dto.classTemplateIds ?? [],
              cancelReason,
              previewFingerprint: dto.previewFingerprint,
              cancelledCount: result.cancelledCount,
              cancelledBookingCount: result.cancelledBookingCount,
              expiredWaitlistCount: result.expiredWaitlistCount,
              protectedCount: preview.protectedClasses.length,
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

  private validateRange(dto: RangeCancelPreviewDto, timezone: string) {
    for (const key of [dto.fromDate, dto.toDate]) {
      const [y, m, d] = key.split('-').map(Number);
      if (new Date(Date.UTC(y!, m! - 1, d!)).toISOString().slice(0, 10) !== key) {
        throw new BadRequestException(`Fecha inválida: ${key}.`);
      }
    }
    if (dto.toDate < dto.fromDate) {
      throw new BadRequestException('La fecha final debe ser igual o posterior a la fecha inicial.');
    }
    const days = Math.round((dateKeyUtcMs(dto.toDate) - dateKeyUtcMs(dto.fromDate)) / 86_400_000) + 1;
    if (days > RANGE_CANCEL_MAX_DAYS) {
      throw new BadRequestException(`El rango no puede exceder ${RANGE_CANCEL_MAX_DAYS} días.`);
    }
    return studioLocalRangeToUtc(dto.fromDate, dto.toDate, timezone);
  }

  /** Filter ids must belong to this studio; foreign ids are rejected, never silently ignored. */
  private async validateFilters(studioId: string, dto: RangeCancelPreviewDto) {
    const templateIds = [...new Set(dto.classTemplateIds ?? [])];
    if (templateIds.length > 0) {
      const found = await this.prisma.classTemplate.count({ where: { id: { in: templateIds }, studioId } });
      if (found !== templateIds.length) throw new BadRequestException('Uno o más tipos de clase no pertenecen a este estudio.');
    }
    const instructorIds = [...new Set(dto.instructorIds ?? [])];
    if (instructorIds.length > 0) {
      const found = await this.prisma.studioMembership.count({
        where: { studioId, userId: { in: instructorIds }, deletedAt: null },
      });
      if (found !== instructorIds.length) throw new BadRequestException('Uno o más instructores no pertenecen a este estudio.');
    }
  }

  private async buildPreview(
    db: Prisma.TransactionClient | PrismaService,
    studioId: string,
    timezone: string,
    dto: RangeCancelPreviewDto,
    range: { start: Date; end: Date },
    now: Date,
  ): Promise<RangeCancelPreview> {
    const where: Prisma.ScheduledClassWhereInput = {
      studioId,
      startsAt: { gte: range.start, lt: range.end },
      ...(dto.instructorIds?.length ? { instructorId: { in: dto.instructorIds } } : {}),
      ...(dto.classTemplateIds?.length ? { classTemplateId: { in: dto.classTemplateIds } } : {}),
    };
    const rows: RangeRow[] = await db.scheduledClass.findMany({
      where: { ...where, status: { in: [ClassStatus.SCHEDULED, ClassStatus.COMPLETED] } },
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
    const alreadyCancelledCount = await db.scheduledClass.count({ where: { ...where, status: ClassStatus.CANCELLED } });

    const classes: RangeCancelClassItem[] = [];
    const protectedClasses: RangeCancelProtectedItem[] = [];
    for (const row of rows) {
      const item = this.toItem(row, timezone);
      const reason = protectedClassReason(
        { startsAt: row.startsAt, status: row.status, attendanceCount: row._count.attendances },
        now,
      );
      if (reason) protectedClasses.push({ ...item, reason, attendances: row._count.attendances });
      else classes.push(item);
    }
    if (classes.length > RANGE_CANCEL_MAX_CLASSES) {
      throw new BadRequestException(
        `El rango incluye ${classes.length} clases; el máximo por operación es ${RANGE_CANCEL_MAX_CLASSES}. Divide el rango.`,
      );
    }
    const totals = {
      classes: classes.length,
      bookings: classes.reduce((sum, c) => sum + c.bookings, 0),
      waitlist: classes.reduce((sum, c) => sum + c.waitlist, 0),
      protected: protectedClasses.length,
    };
    return {
      timezone,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      rangeStartUtc: range.start.toISOString(),
      rangeEndUtc: range.end.toISOString(),
      weekCount: calendarWeekCount(dto.fromDate, dto.toDate),
      classes,
      protectedClasses,
      alreadyCancelledCount,
      totals,
      previewFingerprint: this.fingerprint(classes, protectedClasses),
    };
  }

  /** Binds a confirmation to the exact targets and their reservation impact at preview time. */
  private fingerprint(classes: RangeCancelClassItem[], protectedClasses: RangeCancelProtectedItem[]): string {
    const lines = [
      ...classes.map((c) => `C|${c.id}|${c.startsAt}|${c.bookings}|${c.waitlist}`),
      ...protectedClasses.map((c) => `P|${c.id}|${c.reason}`),
    ];
    return createHash('sha256').update(lines.join('\n')).digest('hex');
  }

  private toItem(row: RangeRow, timezone: string): RangeCancelClassItem {
    const instructorName = row.instructor
      ? `${row.instructor.firstName} ${row.instructor.lastName}`.trim() || null
      : null;
    return {
      id: row.id,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      localDate: getStudioLocalDateKey(row.startsAt, timezone),
      localTime: getStudioLocalHHmm(row.startsAt, timezone),
      classTemplateId: row.classTemplateId,
      className: row.classTemplate.name,
      instructorId: row.instructorId,
      instructorName,
      seriesId: row.scheduleTemplateId,
      bookings: row._count.bookings,
      waitlist: row._count.waitlist,
    };
  }

  /** Same key + same confirmed preview → first result. Same key, other range/preview → 409. */
  private async findReplay(
    tx: Prisma.TransactionClient,
    studioId: string,
    dto: RangeCancelExecuteDto,
  ): Promise<RangeCancelResult | null> {
    const row = await tx.auditLog.findFirst({
      where: {
        studioId,
        action: RANGE_CANCEL_AUDIT_ACTION,
        metadata: { path: ['idempotencyKey'], equals: dto.idempotencyKey },
      },
      orderBy: { createdAt: 'asc' },
    });
    const meta = row?.metadata as { result?: RangeCancelResult; previewFingerprint?: string } | null | undefined;
    if (!meta?.result) return null;
    if (meta.previewFingerprint !== dto.previewFingerprint) {
      throw new ConflictException('Esta clave de confirmación ya se usó para otra cancelación por rango.');
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
}
