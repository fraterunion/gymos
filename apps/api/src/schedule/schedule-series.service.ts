import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingStatus,
  ClassStatus,
  Prisma,
  ScheduleOccurrenceExceptionKind,
} from '@prisma/client';
import {
  addDaysToDateKey,
  getDayOfWeekFromDateKey,
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
  studioLocalTimeToUtc,
} from '../common/date/studio-local-date';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import {
  buildCandidatesForTemplateInRange,
  indexExistingOccurrences,
  isLegacyUnboundedTemplate,
  isTemplateActiveOnDateKey,
  lastRecurrenceDateKeyStrictlyBefore,
  MaterializableTemplate,
  shouldSkipCandidate,
  templateEffectiveEndKey,
  templateEffectiveStartKey,
} from './schedule-materialization';
import { ScheduleConflictsService } from './schedule-conflicts.service';
import { cascadeClassCancellationInTx } from './cascade-class-cancellation';
import { assertStartsBeforeEnds } from './occurrence-interval';
import {
  deriveSeriesStatus,
  matchesSeriesListFilter,
  occurrenceExceptionLabel,
  recurrenceEndsOnKey,
  recurrenceStartsOnKey,
  SeriesUiStatus,
  weekdayLabelEs,
} from './schedule-series-projection';
import {
  lastScheduledLocalDateKey,
  occurrenceEndsAtForDateKey,
  occurrenceStartsAtForDateKey,
  planFinishSeriesBoundary,
  planSeriesRecurrenceReconciliation,
  type FutureOccurrenceRow,
} from './schedule-series-recurrence-reconcile';

export type SeriesMutationScope = 'SINGLE' | 'FOLLOWING' | 'SERIES';

export type CreateRecurringSeriesInput = {
  classTemplateId: string;
  instructorId?: string | null;
  capacity?: number;
  daysOfWeek: number[];
  startTime: string;
  intervalWeeks?: number;
  startsOn: string;
  endsOn?: string | null;
  confirmWarnings?: boolean;
};

export type EditOccurrenceInput = {
  scope: SeriesMutationScope;
  localStart?: { date: string; time: string };
  localEnd?: { date: string; time: string };
  capacity?: number;
  instructorId?: string | null;
  intervalWeeks?: number;
  /** undefined = unchanged, null = unbounded end */
  endsOn?: string | null;
  confirmReservations?: boolean;
};

export type SeriesRecurrenceImpact = {
  keptCount: number;
  cancelledCount: number;
  materializeCount: number;
  skippedDetachedCount: number;
  skippedAttendanceCount: number;
  bookedOccurrencesAffected: number;
  previousIntervalWeeks: number;
  newIntervalWeeks: number;
  previousEndsOn: string | null;
  newEndsOn: string | null;
};

export type FinishSeriesInput = {
  mode: 'AFTER_LAST_SCHEDULED' | 'ON_DATE';
  boundaryDate?: string;
  cancelReason?: string;
  confirmReservations?: boolean;
};

export type FinishSeriesPreview = {
  boundaryDateKey: string;
  impact: MutationImpact;
  cancelledCount: number;
  bookedOccurrencesAffected: number;
  skippedDetachedCount: number;
};

export type SeriesPreviewResult = {
  classCount: number;
  breakdown: Record<string, { name: string; count: number }>;
  conflicts: Awaited<ReturnType<ScheduleConflictsService['findConflictsForSlots']>>;
  blockingConflictCount: number;
  warningConflictCount: number;
};

export type MutationImpact = {
  affectedClassCount: number;
  classesWithReservations: number;
  totalReservations: number;
};

export type SeriesListFilter = {
  status?: 'all' | 'active' | 'ended';
  search?: string;
  instructorId?: string;
};

export type SeriesListItemDto = {
  id: string;
  classTemplate: {
    id: string;
    name: string;
    durationMinutes: number;
    color: string | null;
  };
  instructor: { id: string; name: string } | null;
  localSchedule: {
    weekday: number;
    weekdayLabel: string;
    startsAtLocal: string;
    durationMinutes: number;
  };
  recurrence: {
    intervalWeeks: number;
    startsOn: string | null;
    endsOn: string | null;
    isLegacy: boolean;
  };
  status: SeriesUiStatus;
  nextOccurrence: {
    id: string;
    startsAt: string;
    status: ClassStatus;
    exception: 'DETACHED' | 'CANCELLED' | null;
  } | null;
  futureOccurrenceCount: number;
  futureBookingCount: number;
};

export type SeriesDetailOccurrenceDto = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: ClassStatus;
  exception: 'DETACHED' | 'CANCELLED' | null;
};

export type SeriesDetailDto = SeriesListItemDto & {
  capacity: number;
  upcomingOccurrences: SeriesDetailOccurrenceDto[];
  anchorOccurrenceId: string | null;
};

const DEFAULT_HORIZON_DAYS = 90;

/** Detached occurrences survive configuration edits but not explicit series cancellation. */
function isDetachedOccurrence(
  exceptionKind: ScheduleOccurrenceExceptionKind | null | undefined,
): boolean {
  return exceptionKind === ScheduleOccurrenceExceptionKind.DETACHED;
}

@Injectable()
export class ScheduleSeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conflicts: ScheduleConflictsService,
    private readonly audit: AuditService,
  ) {}

  async previewCreate(studioId: string, input: CreateRecurringSeriesInput): Promise<SeriesPreviewResult> {
    const studio = await this.requireStudio(studioId);
    const classTemplate = await this.requireClassTemplate(studioId, input.classTemplateId);
    this.validateCreateInput(input);

    const horizonDays = await this.getHorizonDays(studioId);
    const candidates = await this.buildCreateCandidates(
      studioId,
      studio.timezone,
      input,
      classTemplate.durationMinutes,
      classTemplate.defaultCapacity,
      classTemplate.name,
      horizonDays,
      null,
    );

    const conflicts = await this.conflicts.findConflictsForSlots(
      studioId,
      candidates.map((c) => ({
        classTemplateId: c.classTemplateId,
        instructorId: c.instructorId,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        capacity: c.capacity,
      })),
    );

    const { blocking, warnings } = this.conflicts.partitionConflicts(conflicts);
    const breakdown: Record<string, { name: string; count: number }> = {};
    for (const c of candidates) {
      if (!breakdown[c.classTemplateId]) {
        breakdown[c.classTemplateId] = { name: c.templateName, count: 0 };
      }
      breakdown[c.classTemplateId]!.count++;
    }

    return {
      classCount: candidates.length,
      breakdown,
      conflicts,
      blockingConflictCount: blocking.length,
      warningConflictCount: warnings.length,
    };
  }

  async createRecurringSeries(
    studioId: string,
    input: CreateRecurringSeriesInput,
    actorUserId: string,
  ) {
    const preview = await this.previewCreate(studioId, input);
    if (preview.blockingConflictCount > 0) {
      throw new ConflictException({
        message: 'Blocking conflicts prevent creating this series.',
        conflicts: preview.conflicts.filter((c) => c.severity === 'BLOCKING'),
      });
    }
    if (preview.warningConflictCount > 0 && !input.confirmWarnings) {
      throw new BadRequestException({
        message: 'Warnings require confirmation.',
        conflicts: preview.conflicts.filter((c) => c.severity === 'WARNING'),
        requiresConfirmation: true,
      });
    }

    const studio = await this.requireStudio(studioId);
    const classTemplate = await this.requireClassTemplate(studioId, input.classTemplateId);
    if (input.instructorId) {
      await this.assertActiveStudioMember(studioId, input.instructorId);
    }

    const startsAtAnchor = studioLocalDateKeyToUtcAnchor(input.startsOn, studio.timezone);
    const endsAtAnchor = input.endsOn
      ? studioLocalDateKeyToUtcAnchor(input.endsOn, studio.timezone)
      : null;
    const intervalWeeks = input.intervalWeeks ?? 1;

    const createdTemplates = await this.prisma.$transaction(async (tx) => {
      const templates = [];
      for (const dow of input.daysOfWeek) {
        const tpl = await tx.scheduleTemplate.create({
          data: {
            studioId,
            classTemplateId: input.classTemplateId,
            instructorId: input.instructorId ?? null,
            dayOfWeek: dow,
            startTime: input.startTime,
            capacity: input.capacity ?? null,
            startsAt: startsAtAnchor,
            endsAt: endsAtAnchor,
            intervalWeeks,
            active: true,
          },
        });
        templates.push(tpl);
      }

      const horizonDays = await this.getHorizonDays(studioId);
      const materialized = await this.materializeTemplates(
        tx,
        studioId,
        studio.timezone,
        templates.map((t) => ({
          ...t,
          classTemplate,
        })),
        horizonDays,
      );

      await this.audit.log({
        studioId,
        actorUserId,
        action: 'SCHEDULE_RECURRING_SERIES_CREATED',
        entityType: 'ScheduleTemplate',
        entityId: templates[0]?.id,
        metadata: {
          scope: 'SERIES',
          classTemplateId: input.classTemplateId,
          templateIds: templates.map((t) => t.id),
          daysOfWeek: input.daysOfWeek,
          startTime: input.startTime,
          startsOn: input.startsOn,
          endsOn: input.endsOn ?? null,
          intervalWeeks,
          materializedCount: materialized.generated,
          skippedCount: materialized.skipped,
        },
      });

      return { templates, materialized };
    });

    return createdTemplates;
  }

  async listSeries(
    studioId: string,
    filter: SeriesListFilter = {},
  ): Promise<SeriesListItemDto[]> {
    const studio = await this.requireStudio(studioId);
    const todayKey = getStudioLocalDateKey(new Date(), studio.timezone);
    const now = new Date();

    const templates = await this.prisma.scheduleTemplate.findMany({
      where: { studioId, deletedAt: null },
      include: {
        classTemplate: {
          select: {
            id: true,
            name: true,
            durationMinutes: true,
            color: true,
            defaultCapacity: true,
          },
        },
        instructor: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
    });

    if (templates.length === 0) return [];

    const templateIds = templates.map((t) => t.id);
    const [futureRows, earliestByTemplate] = await Promise.all([
      this.prisma.scheduledClass.findMany({
        where: {
          studioId,
          scheduleTemplateId: { in: templateIds },
          startsAt: { gte: now },
        },
        orderBy: { startsAt: 'asc' },
        select: {
          id: true,
          scheduleTemplateId: true,
          startsAt: true,
          status: true,
          exceptionKind: true,
        },
      }),
      this.prisma.scheduledClass.groupBy({
        by: ['scheduleTemplateId'],
        where: { studioId, scheduleTemplateId: { in: templateIds } },
        _min: { startsAt: true },
      }),
    ]);

    const earliestMap = new Map(
      earliestByTemplate.map((row) => [row.scheduleTemplateId!, row._min.startsAt]),
    );

    const futureByTemplate = new Map<string, typeof futureRows>();
    for (const row of futureRows) {
      if (!row.scheduleTemplateId) continue;
      const arr = futureByTemplate.get(row.scheduleTemplateId) ?? [];
      arr.push(row);
      futureByTemplate.set(row.scheduleTemplateId, arr);
    }

    const futureScheduledIds = futureRows
      .filter((r) => r.status === ClassStatus.SCHEDULED)
      .map((r) => r.id);

    const bookingAgg =
      futureScheduledIds.length > 0
        ? await this.prisma.booking.groupBy({
            by: ['scheduledClassId'],
            where: {
              scheduledClassId: { in: futureScheduledIds },
              status: BookingStatus.CONFIRMED,
            },
            _count: { _all: true },
          })
        : [];

    const bookingsByClass = new Map(
      bookingAgg.map((row) => [row.scheduledClassId, row._count._all]),
    );

    const items: SeriesListItemDto[] = [];
    for (const tpl of templates) {
      const occurrences = futureByTemplate.get(tpl.id) ?? [];
      const futureScheduled = occurrences.filter((o) => o.status === ClassStatus.SCHEDULED);
      const next = futureScheduled[0] ?? null;

      let futureBookingCount = 0;
      for (const occ of futureScheduled) {
        futureBookingCount += bookingsByClass.get(occ.id) ?? 0;
      }

      const materializable = {
        ...tpl,
        classTemplate: tpl.classTemplate,
      };
      const status = deriveSeriesStatus(tpl, studio.timezone, todayKey);
      const instructorName = tpl.instructor
        ? `${tpl.instructor.firstName} ${tpl.instructor.lastName}`.trim()
        : null;

      const item: SeriesListItemDto = {
        id: tpl.id,
        classTemplate: {
          id: tpl.classTemplate.id,
          name: tpl.classTemplate.name,
          durationMinutes: tpl.classTemplate.durationMinutes,
          color: tpl.classTemplate.color,
        },
        instructor: tpl.instructor
          ? { id: tpl.instructor.id, name: instructorName! }
          : null,
        localSchedule: {
          weekday: tpl.dayOfWeek,
          weekdayLabel: weekdayLabelEs(tpl.dayOfWeek),
          startsAtLocal: tpl.startTime,
          durationMinutes: tpl.classTemplate.durationMinutes,
        },
        recurrence: {
          intervalWeeks: tpl.intervalWeeks,
          startsOn: recurrenceStartsOnKey(
            materializable,
            studio.timezone,
            earliestMap.get(tpl.id) ?? null,
          ),
          endsOn: recurrenceEndsOnKey(materializable, studio.timezone),
          isLegacy: isLegacyUnboundedTemplate(materializable),
        },
        status,
        nextOccurrence: next
          ? {
              id: next.id,
              startsAt: next.startsAt.toISOString(),
              status: next.status,
              exception: occurrenceExceptionLabel(next.status, next.exceptionKind),
            }
          : null,
        futureOccurrenceCount: futureScheduled.length,
        futureBookingCount,
      };

      if (
        matchesSeriesListFilter(
          {
            status: item.status,
            classTemplateName: item.classTemplate.name,
            instructorName,
            instructorId: tpl.instructorId,
          },
          filter,
        )
      ) {
        items.push(item);
      }
    }

    return items;
  }

  async getSeriesDetail(studioId: string, templateId: string): Promise<SeriesDetailDto> {
    const studio = await this.requireStudio(studioId);
    const tpl = await this.requireTemplate(studioId, templateId);
    const todayKey = getStudioLocalDateKey(new Date(), studio.timezone);
    const now = new Date();

    const [futureRows, earliestRow] = await Promise.all([
      this.prisma.scheduledClass.findMany({
        where: {
          studioId,
          scheduleTemplateId: tpl.id,
          startsAt: { gte: now },
        },
        orderBy: { startsAt: 'asc' },
        take: 6,
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          status: true,
          exceptionKind: true,
        },
      }),
      this.prisma.scheduledClass.aggregate({
        where: { studioId, scheduleTemplateId: tpl.id },
        _min: { startsAt: true },
      }),
    ]);

    const futureScheduled = await this.prisma.scheduledClass.findMany({
      where: {
        studioId,
        scheduleTemplateId: tpl.id,
        startsAt: { gte: now },
        status: ClassStatus.SCHEDULED,
      },
      select: { id: true },
    });

    const impact = await this.countReservationImpact(futureScheduled.map((r) => r.id));
    const materializable = { ...tpl, classTemplate: tpl.classTemplate };
    const status = deriveSeriesStatus(tpl, studio.timezone, todayKey);
    const instructorName = tpl.instructor
      ? `${tpl.instructor.firstName} ${tpl.instructor.lastName}`.trim()
      : null;

    const nextScheduled = futureRows.find((o) => o.status === ClassStatus.SCHEDULED) ?? null;
    const listCore: SeriesListItemDto = {
      id: tpl.id,
      classTemplate: {
        id: tpl.classTemplate.id,
        name: tpl.classTemplate.name,
        durationMinutes: tpl.classTemplate.durationMinutes,
        color: tpl.classTemplate.color,
      },
      instructor: tpl.instructor ? { id: tpl.instructor.id, name: instructorName! } : null,
      localSchedule: {
        weekday: tpl.dayOfWeek,
        weekdayLabel: weekdayLabelEs(tpl.dayOfWeek),
        startsAtLocal: tpl.startTime,
        durationMinutes: tpl.classTemplate.durationMinutes,
      },
      recurrence: {
        intervalWeeks: tpl.intervalWeeks,
        startsOn: recurrenceStartsOnKey(
          materializable,
          studio.timezone,
          earliestRow._min.startsAt,
        ),
        endsOn: recurrenceEndsOnKey(materializable, studio.timezone),
        isLegacy: isLegacyUnboundedTemplate(materializable),
      },
      status,
      nextOccurrence: nextScheduled
        ? {
            id: nextScheduled.id,
            startsAt: nextScheduled.startsAt.toISOString(),
            status: nextScheduled.status,
            exception: occurrenceExceptionLabel(
              nextScheduled.status,
              nextScheduled.exceptionKind,
            ),
          }
        : null,
      futureOccurrenceCount: futureScheduled.length,
      futureBookingCount: impact.totalReservations,
    };

    return {
      ...listCore,
      capacity: tpl.capacity ?? tpl.classTemplate.defaultCapacity,
      upcomingOccurrences: futureRows.map((row) => ({
        id: row.id,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        status: row.status,
        exception: occurrenceExceptionLabel(row.status, row.exceptionKind),
      })),
      anchorOccurrenceId: nextScheduled?.id ?? null,
    };
  }

  async previewFinishSeries(
    studioId: string,
    templateId: string,
    input: FinishSeriesInput,
  ): Promise<FinishSeriesPreview> {
    const studio = await this.requireStudio(studioId);
    const tpl = await this.requireTemplate(studioId, templateId);
    const boundaryDateKey = await this.resolveFinishBoundaryDateKey(
      studio.id,
      tpl.id,
      studio.timezone,
      input,
    );
    const futureRows = await this.loadFutureOccurrenceRows(studio.id, tpl.id);
    const plan = planFinishSeriesBoundary(
      { ...tpl, classTemplate: tpl.classTemplate },
      studio.timezone,
      boundaryDateKey,
      futureRows,
    );
    const impact = await this.countReservationImpact(plan.cancelIds);
    return {
      boundaryDateKey,
      impact,
      cancelledCount: plan.cancelledCount,
      bookedOccurrencesAffected: plan.bookedCancellationCount,
      skippedDetachedCount: plan.skippedDetachedCount,
    };
  }

  async finishSeries(
    studioId: string,
    templateId: string,
    input: FinishSeriesInput,
    actorUserId: string,
  ) {
    const preview = await this.previewFinishSeries(studioId, templateId, input);
    if (
      preview.bookedOccurrencesAffected > 0 &&
      !input.confirmReservations
    ) {
      throw new BadRequestException({
        message: 'Finalizing the series affects reservations and requires confirmation.',
        preview,
        requiresConfirmation: true,
      });
    }

    const studio = await this.requireStudio(studioId);
    const tpl = await this.requireTemplate(studioId, templateId);
    const boundaryDateKey = preview.boundaryDateKey;
    const futureRows = await this.loadFutureOccurrenceRows(studio.id, tpl.id);
    const plan = planFinishSeriesBoundary(
      { ...tpl, classTemplate: tpl.classTemplate },
      studio.timezone,
      boundaryDateKey,
      futureRows,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.scheduleTemplate.update({
        where: { id: tpl.id },
        data: {
          endsAt: studioLocalDateKeyToUtcAnchor(boundaryDateKey, studio.timezone),
          active: true,
        },
      });

      if (plan.cancelIds.length > 0) {
        await tx.scheduledClass.updateMany({
          where: { id: { in: plan.cancelIds } },
          data: {
            status: ClassStatus.CANCELLED,
            ...(input.cancelReason ? { cancelReason: input.cancelReason } : {}),
          },
        });
        const cascade = await cascadeClassCancellationInTx(tx, {
          studioId: studio.id,
          scheduledClassIds: plan.cancelIds,
        });
        return { cancelledCount: plan.cancelIds.length, ...cascade };
      }

      return { cancelledCount: 0, cancelledBookingCount: 0, expiredWaitlistCount: 0 };
    });

    await this.audit.log({
      studioId: studio.id,
      actorUserId,
      action: 'SCHEDULE_SERIES_FINISHED',
      entityType: 'ScheduleTemplate',
      entityId: tpl.id,
      metadata: {
        mode: input.mode,
        boundaryDateKey,
        cancelledCount: result.cancelledCount,
        cancelledBookingCount: result.cancelledBookingCount,
        expiredWaitlistCount: result.expiredWaitlistCount,
        skippedDetachedCount: plan.skippedDetachedCount,
        affectedReservationCount: preview.impact.totalReservations,
        cancelReason: input.cancelReason ?? null,
      },
    });

    return { boundaryDateKey, cancelledCount: result.cancelledCount };
  }

  async getOccurrenceSeriesContext(studioId: string, scheduledClassId: string) {
    const row = await this.prisma.scheduledClass.findFirst({
      where: { id: scheduledClassId, studioId },
      include: {
        scheduleTemplate: {
          include: {
            classTemplate: { select: { name: true } },
            instructor: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Scheduled class not found');
    if (!row.scheduleTemplateId || !row.scheduleTemplate) {
      return { isRecurring: false as const };
    }
    const tpl = row.scheduleTemplate;
    const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    return {
      isRecurring: true as const,
      scheduleTemplateId: tpl.id,
      label: `Todos los ${dayNames[tpl.dayOfWeek]} · ${tpl.startTime}`,
      dayOfWeek: tpl.dayOfWeek,
      startTime: tpl.startTime,
      startsAt: tpl.startsAt?.toISOString() ?? null,
      endsAt: tpl.endsAt?.toISOString() ?? null,
      intervalWeeks: tpl.intervalWeeks,
      active: tpl.active,
    };
  }

  async previewEditOccurrence(
    studioId: string,
    scheduledClassId: string,
    input: EditOccurrenceInput,
  ): Promise<{
    impact: MutationImpact;
    recurrenceImpact?: SeriesRecurrenceImpact;
    conflicts: ScheduleConflictsService['findConflictsForSlots'] extends (...args: never[]) => Promise<infer R> ? R : never;
  }> {
    const occurrence = await this.requireOccurrence(studioId, scheduledClassId);
    const studio = await this.requireStudio(studioId);

    let recurrenceImpact: SeriesRecurrenceImpact | undefined;
    if (
      input.scope === 'SERIES' &&
      occurrence.scheduleTemplate &&
      this.hasRecurrenceFieldChanges(input)
    ) {
      recurrenceImpact = await this.computeSeriesRecurrenceImpact(
        studio,
        occurrence.scheduleTemplate,
        input,
      );
    }

    let impact: MutationImpact;
    if (recurrenceImpact) {
      const cancelBookingImpact = await this.countReservationImpact(
        await this.bookedIdsFromPlan(
          studioId,
          occurrence.scheduleTemplate!.id,
          occurrence.scheduleTemplate!,
          input,
          studio.timezone,
        ),
      );
      impact = {
        affectedClassCount:
          recurrenceImpact.keptCount +
          recurrenceImpact.cancelledCount +
          recurrenceImpact.materializeCount,
        classesWithReservations: cancelBookingImpact.classesWithReservations,
        totalReservations: cancelBookingImpact.totalReservations,
      };
    } else {
      impact = await this.computeEditImpact(studioId, occurrence, input);
    }

    const slots = await this.buildEditSlots(studioId, occurrence, input);
    const conflicts = await this.conflicts.findConflictsForSlots(studioId, slots);
    return { impact, recurrenceImpact, conflicts };
  }

  async editOccurrence(
    studioId: string,
    scheduledClassId: string,
    input: EditOccurrenceInput,
    actorUserId: string,
  ) {
    const occurrence = await this.requireOccurrence(studioId, scheduledClassId);
    if (!occurrence.scheduleTemplateId && input.scope !== 'SINGLE') {
      throw new BadRequestException('Series scope requires a recurring occurrence.');
    }

    const preview = await this.previewEditOccurrence(studioId, scheduledClassId, input);
    const { blocking } = this.conflicts.partitionConflicts(preview.conflicts);
    if (blocking.length > 0) {
      throw new ConflictException({ message: 'Blocking conflicts.', conflicts: blocking });
    }

    const hasReservationImpact = preview.impact.totalReservations > 0;
    const hasTimeOrInstructorChange =
      input.localStart !== undefined || input.instructorId !== undefined;
    const hasRecurrenceRemovalImpact =
      (preview.recurrenceImpact?.bookedOccurrencesAffected ?? 0) > 0;
    if (
      hasReservationImpact &&
      (hasTimeOrInstructorChange || hasRecurrenceRemovalImpact) &&
      !input.confirmReservations
    ) {
      throw new BadRequestException({
        message: 'Reservation impact requires confirmation.',
        impact: preview.impact,
        recurrenceImpact: preview.recurrenceImpact,
        requiresConfirmation: true,
      });
    }

    if (input.capacity !== undefined) {
      if (input.scope === 'SINGLE') {
        await this.conflicts.assertCapacityNotBelowBookings(scheduledClassId, input.capacity);
      } else {
        const targets = await this.resolveEditTargets(studioId, occurrence, input.scope);
        for (const t of targets) {
          await this.conflicts.assertCapacityNotBelowBookings(t.id, input.capacity);
        }
      }
    }

    const studio = await this.requireStudio(studioId);

    if (input.scope === 'SINGLE') {
      return this.editSingleOccurrence(studio, occurrence, input, actorUserId, preview.impact);
    }
    if (input.scope === 'FOLLOWING') {
      return this.editFollowingOccurrences(studio, occurrence, input, actorUserId, preview.impact);
    }
    return this.editEntireSeries(studio, occurrence, input, actorUserId, preview.impact);
  }

  async previewCancelOccurrence(
    studioId: string,
    scheduledClassId: string,
    scope: SeriesMutationScope,
  ): Promise<MutationImpact> {
    const occurrence = await this.requireOccurrence(studioId, scheduledClassId);
    return this.computeCancelImpact(studioId, occurrence, scope);
  }

  async cancelOccurrence(
    studioId: string,
    scheduledClassId: string,
    scope: SeriesMutationScope,
    actorUserId: string,
    cancelReason?: string,
    confirmReservations?: boolean,
  ) {
    const occurrence = await this.requireOccurrence(studioId, scheduledClassId);
    const impact = await this.computeCancelImpact(studioId, occurrence, scope);
    if (impact.totalReservations > 0 && !confirmReservations) {
      throw new BadRequestException({
        message: 'Cancellation affects reservations and requires confirmation.',
        impact,
        requiresConfirmation: true,
      });
    }

    const studio = await this.requireStudio(studioId);

    if (scope === 'SINGLE') {
      await this.cancelSingleOccurrence(studio.id, occurrence, actorUserId, cancelReason, impact);
      return { cancelledCount: 1 };
    }
    if (scope === 'FOLLOWING') {
      return this.cancelFollowingOccurrences(studio, occurrence, actorUserId, cancelReason, impact);
    }
    return this.cancelEntireSeries(studio, occurrence, actorUserId, cancelReason, impact);
  }

  // ── private helpers ─────────────────────────────────────────────────────

  private async requireStudio(studioId: string) {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { id: true, timezone: true },
    });
    if (!studio) throw new NotFoundException('Studio not found');
    return studio;
  }

  private async requireClassTemplate(studioId: string, classTemplateId: string) {
    const tpl = await this.prisma.classTemplate.findFirst({
      where: { id: classTemplateId, studioId, deletedAt: null },
    });
    if (!tpl) throw new NotFoundException('Class template not found');
    return tpl;
  }

  private async requireTemplate(studioId: string, templateId: string) {
    const row = await this.prisma.scheduleTemplate.findFirst({
      where: { id: templateId, studioId, deletedAt: null },
      include: {
        classTemplate: {
          select: {
            id: true,
            name: true,
            durationMinutes: true,
            color: true,
            defaultCapacity: true,
          },
        },
        instructor: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!row) throw new NotFoundException('Schedule series not found');
    return row;
  }

  private async requireOccurrence(studioId: string, scheduledClassId: string) {
    const row = await this.prisma.scheduledClass.findFirst({
      where: { id: scheduledClassId, studioId },
      include: {
        scheduleTemplate: {
          include: { classTemplate: true },
        },
      },
    });
    if (!row) throw new NotFoundException('Scheduled class not found');
    return row;
  }

  private validateCreateInput(input: CreateRecurringSeriesInput) {
    if (!input.daysOfWeek?.length) {
      throw new BadRequestException('At least one weekday is required.');
    }
    if (!/^\d{2}:\d{2}$/.test(input.startTime)) {
      throw new BadRequestException('startTime must be HH:mm');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startsOn)) {
      throw new BadRequestException('startsOn must be YYYY-MM-DD');
    }
    if (input.endsOn && input.endsOn < input.startsOn) {
      throw new BadRequestException('endsOn must be on or after startsOn');
    }
    const interval = input.intervalWeeks ?? 1;
    if (interval < 1 || interval > 52) {
      throw new BadRequestException('intervalWeeks must be between 1 and 52');
    }
  }

  private async getHorizonDays(studioId: string): Promise<number> {
    const settings = await this.prisma.scheduleAutomationSettings.findUnique({
      where: { studioId },
    });
    return settings?.minFutureDays ?? DEFAULT_HORIZON_DAYS;
  }

  private computeMaterializationEndKey(
    startsOn: string,
    endsOn: string | null | undefined,
    horizonDays: number,
    timezone: string,
  ): string {
    const horizonEnd = addDaysToDateKey(getStudioLocalDateKey(new Date(), timezone), horizonDays);
    if (!endsOn) return horizonEnd;
    return endsOn < horizonEnd ? endsOn : horizonEnd;
  }

  private async buildCreateCandidates(
    studioId: string,
    timezone: string,
    input: CreateRecurringSeriesInput,
    durationMinutes: number,
    defaultCapacity: number,
    classTemplateName: string,
    horizonDays: number,
    excludeTemplateId: string | null,
  ) {
    const endKey = this.computeMaterializationEndKey(
      input.startsOn,
      input.endsOn,
      horizonDays,
      timezone,
    );
    const toExclusive = addDaysToDateKey(endKey, 1);
    const capacity = input.capacity ?? defaultCapacity;
    const intervalWeeks = input.intervalWeeks ?? 1;
    const startsAtAnchor = studioLocalDateKeyToUtcAnchor(input.startsOn, timezone);

    const pseudoTemplates: MaterializableTemplate[] = input.daysOfWeek.map((dow) => ({
      id: excludeTemplateId ?? `preview-${dow}`,
      classTemplateId: input.classTemplateId,
      instructorId: input.instructorId ?? null,
      dayOfWeek: dow,
      startTime: input.startTime,
      capacity: input.capacity ?? null,
      startsAt: startsAtAnchor,
      endsAt: input.endsOn
        ? studioLocalDateKeyToUtcAnchor(input.endsOn, timezone)
        : null,
      intervalWeeks,
      classTemplate: {
        id: input.classTemplateId,
        name: classTemplateName,
        durationMinutes,
        defaultCapacity: capacity,
      },
    }));

    const all: ReturnType<typeof buildCandidatesForTemplateInRange> = [];
    for (const tpl of pseudoTemplates) {
      all.push(
        ...buildCandidatesForTemplateInRange(tpl, timezone, input.startsOn, toExclusive),
      );
    }

    const existing = await this.prisma.scheduledClass.findMany({
      where: {
        studioId,
        startsAt: {
          gte: studioLocalDateKeyToUtcAnchor(input.startsOn, timezone),
          lt: studioLocalDateKeyToUtcAnchor(toExclusive, timezone),
        },
      },
      select: {
        classTemplateId: true,
        startsAt: true,
        scheduleTemplateId: true,
        status: true,
      },
    });

    const { dedupKeys, templateDateKeys } = indexExistingOccurrences(existing, timezone);
    return all.filter((c) => !shouldSkipCandidate(c, dedupKeys, templateDateKeys));
  }

  private async materializeTemplates(
    tx: Prisma.TransactionClient,
    studioId: string,
    timezone: string,
    templates: MaterializableTemplate[],
    horizonDays: number,
  ) {
    const nowKey = getStudioLocalDateKey(new Date(), timezone);
    let generated = 0;
    let skipped = 0;

    for (const tpl of templates) {
      const startKey = templateEffectiveStartKey(tpl, timezone);
      const endKey = this.computeMaterializationEndKey(
        startKey,
        templateEffectiveEndKey(tpl, timezone),
        horizonDays,
        timezone,
      );
      const toExclusive = addDaysToDateKey(endKey, 1);
      const candidates = buildCandidatesForTemplateInRange(
        tpl,
        timezone,
        startKey < nowKey ? nowKey : startKey,
        toExclusive,
      );

      const rangeStart = studioLocalDateKeyToUtcAnchor(
        startKey < nowKey ? nowKey : startKey,
        timezone,
      );
      const rangeEnd = studioLocalDateKeyToUtcAnchor(toExclusive, timezone);

      const existing = await tx.scheduledClass.findMany({
        where: {
          studioId,
          startsAt: { gte: rangeStart, lt: rangeEnd },
        },
        select: {
          classTemplateId: true,
          startsAt: true,
          scheduleTemplateId: true,
          status: true,
        },
      });

      const { dedupKeys, templateDateKeys } = indexExistingOccurrences(existing, timezone);
      const toCreate = candidates.filter(
        (c) => !shouldSkipCandidate(c, dedupKeys, templateDateKeys),
      );
      skipped += candidates.length - toCreate.length;

      if (toCreate.length > 0) {
        await tx.scheduledClass.createMany({
          data: toCreate.map((c) => ({
            studioId,
            classTemplateId: c.classTemplateId,
            scheduleTemplateId: c.scheduleTemplateId,
            instructorId: c.instructorId,
            startsAt: c.startsAt,
            endsAt: c.endsAt,
            capacity: c.capacity,
            status: ClassStatus.SCHEDULED,
          })),
          skipDuplicates: true,
        });
        generated += toCreate.length;
      }
    }

    return { generated, skipped };
  }

  private async editSingleOccurrence(
    studio: { id: string; timezone: string },
    occurrence: Awaited<ReturnType<typeof this.requireOccurrence>>,
    input: EditOccurrenceInput,
    actorUserId: string,
    impact: MutationImpact,
  ) {
    const data = await this.buildOccurrenceUpdateData(studio.timezone, occurrence, input);
    const updated = await this.prisma.scheduledClass.update({
      where: { id: occurrence.id },
      data: {
        ...data,
        ...(occurrence.scheduleTemplateId
          ? { exceptionKind: ScheduleOccurrenceExceptionKind.DETACHED }
          : {}),
      },
    });

    await this.audit.log({
      studioId: studio.id,
      actorUserId,
      action: 'SCHEDULE_OCCURRENCE_EDITED',
      entityType: 'ScheduledClass',
      entityId: occurrence.id,
      metadata: {
        scope: 'SINGLE',
        scheduleTemplateId: occurrence.scheduleTemplateId,
        affectedClassCount: 1,
        affectedReservationCount: impact.totalReservations,
        changes: input,
      },
    });

    return updated;
  }

  private async editFollowingOccurrences(
    studio: { id: string; timezone: string },
    occurrence: Awaited<ReturnType<typeof this.requireOccurrence>>,
    input: EditOccurrenceInput,
    actorUserId: string,
    impact: MutationImpact,
  ) {
    const tpl = occurrence.scheduleTemplate!;
    const occurrenceDateKey = getStudioLocalDateKey(occurrence.startsAt, studio.timezone);
    const predecessorEndKey = lastRecurrenceDateKeyStrictlyBefore(
      tpl,
      occurrenceDateKey,
      studio.timezone,
    );

    const newStartTime =
      input.localStart?.time ??
      tpl.startTime;
    const newDayOfWeek = input.localStart
      ? getDayOfWeekFromDateKey(input.localStart.date)
      : tpl.dayOfWeek;

    return this.prisma.$transaction(async (tx) => {
      if (predecessorEndKey) {
        await tx.scheduleTemplate.update({
          where: { id: tpl.id },
          data: {
            endsAt: studioLocalDateKeyToUtcAnchor(predecessorEndKey, studio.timezone),
          },
        });
      } else {
        await tx.scheduleTemplate.update({
          where: { id: tpl.id },
          data: { active: false, endsAt: studioLocalDateKeyToUtcAnchor(occurrenceDateKey, studio.timezone) },
        });
      }

      const newTemplate = await tx.scheduleTemplate.create({
        data: {
          studioId: studio.id,
          classTemplateId: tpl.classTemplateId,
          instructorId:
            input.instructorId !== undefined ? input.instructorId : tpl.instructorId,
          dayOfWeek: newDayOfWeek,
          startTime: newStartTime,
          capacity: input.capacity ?? tpl.capacity,
          startsAt: studioLocalDateKeyToUtcAnchor(occurrenceDateKey, studio.timezone),
          endsAt: tpl.endsAt,
          intervalWeeks: tpl.intervalWeeks,
          active: true,
        },
      });

      const targets = await tx.scheduledClass.findMany({
        where: {
          studioId: studio.id,
          scheduleTemplateId: tpl.id,
          startsAt: { gte: occurrence.startsAt },
          status: ClassStatus.SCHEDULED,
        },
        include: {
          _count: {
            select: {
              attendances: true,
              bookings: { where: { status: BookingStatus.CONFIRMED } },
            },
          },
        },
      });

      let updatedCount = 0;
      let relinkedDetachedCount = 0;
      for (const target of targets) {
        if (target._count.attendances > 0) continue;
        if (target.status === ClassStatus.COMPLETED) continue;

        // Detached exceptions: relink provenance only — never overwrite configuration.
        if (isDetachedOccurrence(target.exceptionKind)) {
          await tx.scheduledClass.update({
            where: { id: target.id },
            data: { scheduleTemplateId: newTemplate.id },
          });
          relinkedDetachedCount++;
          continue;
        }

        const dateKey = getStudioLocalDateKey(target.startsAt, studio.timezone);
        const startsAt = studioLocalTimeToUtc(dateKey, newStartTime, studio.timezone);
        const customSpanMs =
          input.localEnd && input.localStart
            ? studioLocalTimeToUtc(
                input.localEnd.date,
                input.localEnd.time,
                studio.timezone,
              ).getTime() -
              studioLocalTimeToUtc(
                input.localStart.date,
                input.localStart.time,
                studio.timezone,
              ).getTime()
            : null;
        const sameDayCustomEnd =
          Boolean(input.localEnd && input.localStart) &&
          input.localEnd!.date === input.localStart!.date &&
          customSpanMs !== null &&
          customSpanMs > 0;
        const durationMs = sameDayCustomEnd
          ? customSpanMs!
          : tpl.classTemplate.durationMinutes * 60_000;
        const endsAt = new Date(startsAt.getTime() + durationMs);
        assertStartsBeforeEnds(startsAt, endsAt);

        await tx.scheduledClass.update({
          where: { id: target.id },
          data: {
            scheduleTemplateId: newTemplate.id,
            startsAt,
            endsAt,
            capacity: input.capacity ?? target.capacity,
            instructorId:
              input.instructorId !== undefined ? input.instructorId : target.instructorId,
            exceptionKind: null,
          },
        });
        updatedCount++;
      }

      const horizonDays = await this.getHorizonDays(studio.id);
      await this.materializeTemplates(
        tx,
        studio.id,
        studio.timezone,
        [
          {
            ...newTemplate,
            createdAt: newTemplate.createdAt,
            classTemplate: tpl.classTemplate,
          },
        ],
        horizonDays,
      );

      await this.audit.log({
        studioId: studio.id,
        actorUserId,
        action: 'SCHEDULE_SERIES_SPLIT',
        entityType: 'ScheduleTemplate',
        entityId: newTemplate.id,
        metadata: {
          scope: 'FOLLOWING',
          previousTemplateId: tpl.id,
          newTemplateId: newTemplate.id,
          boundaryDateKey: occurrenceDateKey,
          predecessorEndDateKey: predecessorEndKey,
          affectedClassCount: updatedCount,
          relinkedDetachedCount,
          affectedReservationCount: impact.totalReservations,
        },
      });

      return { previousTemplateId: tpl.id, newTemplateId: newTemplate.id, updatedCount };
    });
  }

  private async editEntireSeries(
    studio: { id: string; timezone: string },
    occurrence: Awaited<ReturnType<typeof this.requireOccurrence>>,
    input: EditOccurrenceInput,
    actorUserId: string,
    impact: MutationImpact,
  ) {
    const tpl = occurrence.scheduleTemplate!;
    const newStartTime = input.localStart?.time ?? tpl.startTime;
    const newDayOfWeek = input.localStart
      ? getDayOfWeekFromDateKey(input.localStart.date)
      : tpl.dayOfWeek;
    const hasRecurrenceChange = this.hasRecurrenceFieldChanges(input);

    if (hasRecurrenceChange) {
      return this.editEntireSeriesWithRecurrenceReconciliation(
        studio,
        tpl,
        input,
        actorUserId,
        impact,
        newStartTime,
        newDayOfWeek,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedTemplate = await tx.scheduleTemplate.update({
        where: { id: tpl.id },
        data: {
          startTime: newStartTime,
          dayOfWeek: newDayOfWeek,
          capacity: input.capacity ?? tpl.capacity,
          instructorId:
            input.instructorId !== undefined ? input.instructorId : tpl.instructorId,
        },
        include: { classTemplate: true },
      });

      const now = new Date();
      const futures = await tx.scheduledClass.findMany({
        where: {
          studioId: studio.id,
          scheduleTemplateId: tpl.id,
          startsAt: { gte: now },
          status: ClassStatus.SCHEDULED,
        },
        include: {
          _count: {
            select: {
              attendances: true,
            },
          },
        },
      });

      let updatedCount = 0;
      let skippedDetachedCount = 0;
      for (const target of futures) {
        if (isDetachedOccurrence(target.exceptionKind)) {
          skippedDetachedCount++;
          continue;
        }
        if (target._count.attendances > 0) continue;
        if (target.status === ClassStatus.COMPLETED) continue;

        const dateKey = getStudioLocalDateKey(target.startsAt, studio.timezone);
        if (!isTemplateActiveOnDateKey(updatedTemplate, dateKey, studio.timezone)) {
          continue;
        }

        const startsAt = studioLocalTimeToUtc(dateKey, newStartTime, studio.timezone);
        const endsAt = new Date(
          startsAt.getTime() + updatedTemplate.classTemplate.durationMinutes * 60_000,
        );
        assertStartsBeforeEnds(startsAt, endsAt);

        await tx.scheduledClass.update({
          where: { id: target.id },
          data: {
            startsAt,
            endsAt,
            capacity: input.capacity ?? target.capacity,
            instructorId:
              input.instructorId !== undefined
                ? input.instructorId
                : target.instructorId,
            exceptionKind: null,
          },
        });
        updatedCount++;
      }

      await this.audit.log({
        studioId: studio.id,
        actorUserId,
        action: 'SCHEDULE_SERIES_EDITED',
        entityType: 'ScheduleTemplate',
        entityId: tpl.id,
        metadata: {
          scope: 'SERIES',
          affectedClassCount: updatedCount,
          skippedDetachedCount,
          affectedReservationCount: impact.totalReservations,
        },
      });

      return { templateId: tpl.id, updatedCount };
    });
  }

  private async editEntireSeriesWithRecurrenceReconciliation(
    studio: { id: string; timezone: string },
    tpl: NonNullable<Awaited<ReturnType<typeof this.requireOccurrence>>['scheduleTemplate']>,
    input: EditOccurrenceInput,
    actorUserId: string,
    impact: MutationImpact,
    newStartTime: string,
    newDayOfWeek: number,
  ) {
    const horizonDays = await this.getHorizonDays(studio.id);
    const futureRows = await this.loadFutureOccurrenceRows(studio.id, tpl.id);
    const materializable = { ...tpl, classTemplate: tpl.classTemplate };
    const plan = planSeriesRecurrenceReconciliation(
      materializable,
      {
        intervalWeeks: input.intervalWeeks,
        endsOn: input.endsOn,
        startTime: newStartTime,
        dayOfWeek: newDayOfWeek,
        capacity: input.capacity,
        instructorId: input.instructorId,
      },
      studio.timezone,
      horizonDays,
      futureRows,
    );

    const updatedTemplateData = {
      startTime: newStartTime,
      dayOfWeek: newDayOfWeek,
      capacity: input.capacity ?? tpl.capacity,
      instructorId: input.instructorId !== undefined ? input.instructorId : tpl.instructorId,
      intervalWeeks: input.intervalWeeks ?? tpl.intervalWeeks,
      endsAt:
        input.endsOn === undefined
          ? tpl.endsAt
          : input.endsOn === null
            ? null
            : studioLocalDateKeyToUtcAnchor(input.endsOn, studio.timezone),
    };

    if (isLegacyUnboundedTemplate(materializable) && updatedTemplateData.endsAt === undefined) {
      // preserve legacy null startsAt — endsAt/interval may still change
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedTemplate = await tx.scheduleTemplate.update({
        where: { id: tpl.id },
        data: {
          ...updatedTemplateData,
          ...(isLegacyUnboundedTemplate(materializable) ? { startsAt: null } : {}),
        },
        include: { classTemplate: true },
      });

      let updatedCount = 0;
      let cancelledBookingCount = 0;
      let expiredWaitlistCount = 0;
      for (const id of plan.toUpdateIds) {
        const target = futureRows.find((r) => r.id === id);
        if (!target) continue;
        const dateKey = getStudioLocalDateKey(target.startsAt, studio.timezone);
        const startsAt = occurrenceStartsAtForDateKey(updatedTemplate, dateKey, studio.timezone);
        const endsAt = occurrenceEndsAtForDateKey(updatedTemplate, dateKey, studio.timezone);
        await tx.scheduledClass.update({
          where: { id },
          data: {
            startsAt,
            endsAt,
            capacity:
              input.capacity ??
              updatedTemplate.capacity ??
              tpl.capacity ??
              updatedTemplate.classTemplate.defaultCapacity,
            instructorId:
              input.instructorId !== undefined
                ? input.instructorId
                : updatedTemplate.instructorId,
            exceptionKind: null,
          },
        });
        updatedCount++;
      }

      if (plan.toCancelIds.length > 0) {
        await tx.scheduledClass.updateMany({
          where: { id: { in: plan.toCancelIds } },
          data: { status: ClassStatus.CANCELLED },
        });
        const cascade = await cascadeClassCancellationInTx(tx, {
          studioId: studio.id,
          scheduledClassIds: plan.toCancelIds,
        });
        cancelledBookingCount = cascade.cancelledBookingCount;
        expiredWaitlistCount = cascade.expiredWaitlistCount;
      }

      const materialized = await this.materializeTemplates(
        tx,
        studio.id,
        studio.timezone,
        [updatedTemplate],
        horizonDays,
      );

      await this.audit.log({
        studioId: studio.id,
        actorUserId,
        action: 'SCHEDULE_SERIES_EDITED',
        entityType: 'ScheduleTemplate',
        entityId: tpl.id,
        metadata: {
          scope: 'SERIES',
          previousIntervalWeeks: plan.previousIntervalWeeks,
          newIntervalWeeks: plan.newIntervalWeeks,
          previousEndsOn: plan.previousEndsOn,
          newEndsOn: plan.newEndsOn,
          keptCount: plan.keptCount,
          cancelledCount: plan.cancelledCount,
          materializeCount: materialized.generated,
          skippedDetachedCount: plan.skippedDetachedCount,
          skippedAttendanceCount: plan.skippedAttendanceCount,
          bookedOccurrencesAffected: plan.bookedCancellationCount,
          cancelledBookingCount,
          expiredWaitlistCount,
          affectedClassCount: updatedCount + plan.cancelledCount + materialized.generated,
          affectedReservationCount: impact.totalReservations,
        },
      });

      return {
        templateId: tpl.id,
        updatedCount,
        cancelledCount: plan.cancelledCount,
        materializedCount: materialized.generated,
      };
    });
  }

  private async cancelSingleOccurrence(
    studioId: string,
    occurrence: Awaited<ReturnType<typeof this.requireOccurrence>>,
    actorUserId: string,
    cancelReason: string | undefined,
    impact: MutationImpact,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.scheduledClass.update({
        where: { id: occurrence.id },
        data: {
          status: ClassStatus.CANCELLED,
          ...(cancelReason ? { cancelReason } : {}),
        },
      });
      return cascadeClassCancellationInTx(tx, {
        studioId,
        scheduledClassIds: [occurrence.id],
      });
    });

    await this.audit.log({
      studioId,
      actorUserId,
      action: 'SCHEDULE_OCCURRENCE_CANCELLED',
      entityType: 'ScheduledClass',
      entityId: occurrence.id,
      metadata: {
        scope: 'SINGLE',
        scheduleTemplateId: occurrence.scheduleTemplateId,
        affectedClassCount: 1,
        affectedReservationCount: impact.totalReservations,
        cancelledBookingCount: result.cancelledBookingCount,
        expiredWaitlistCount: result.expiredWaitlistCount,
        cancelReason: cancelReason ?? null,
      },
    });
  }

  private async cancelFollowingOccurrences(
    studio: { id: string; timezone: string },
    occurrence: Awaited<ReturnType<typeof this.requireOccurrence>>,
    actorUserId: string,
    cancelReason: string | undefined,
    impact: MutationImpact,
  ) {
    const tpl = occurrence.scheduleTemplate!;
    const occurrenceDateKey = getStudioLocalDateKey(occurrence.startsAt, studio.timezone);
    const predecessorEndKey = lastRecurrenceDateKeyStrictlyBefore(
      tpl,
      occurrenceDateKey,
      studio.timezone,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      if (predecessorEndKey) {
        await tx.scheduleTemplate.update({
          where: { id: tpl.id },
          data: {
            endsAt: studioLocalDateKeyToUtcAnchor(predecessorEndKey, studio.timezone),
          },
        });
      } else {
        await tx.scheduleTemplate.update({
          where: { id: tpl.id },
          data: { active: false },
        });
      }

      // No successor template — soft-cancel materialized future rows only.
      // Includes DETACHED rows: explicit cancellation from boundary forward.
      const toCancel = await tx.scheduledClass.findMany({
        where: {
          studioId: studio.id,
          scheduleTemplateId: tpl.id,
          startsAt: { gte: occurrence.startsAt },
          status: ClassStatus.SCHEDULED,
        },
        select: { id: true },
      });
      const ids = toCancel.map((row) => row.id);
      if (ids.length > 0) {
        await tx.scheduledClass.updateMany({
          where: { id: { in: ids } },
          data: {
            status: ClassStatus.CANCELLED,
            ...(cancelReason ? { cancelReason } : {}),
          },
        });
        const cascade = await cascadeClassCancellationInTx(tx, {
          studioId: studio.id,
          scheduledClassIds: ids,
        });
        return {
          cancelledCount: ids.length,
          cancelledBookingCount: cascade.cancelledBookingCount,
          expiredWaitlistCount: cascade.expiredWaitlistCount,
        };
      }
      return { cancelledCount: 0, cancelledBookingCount: 0, expiredWaitlistCount: 0 };
    });

    await this.audit.log({
      studioId: studio.id,
      actorUserId,
      action: 'SCHEDULE_FUTURE_SERIES_CANCELLED',
      entityType: 'ScheduleTemplate',
      entityId: tpl.id,
      metadata: {
        scope: 'FOLLOWING',
        previousTemplateId: tpl.id,
        boundaryDateKey: occurrenceDateKey,
        predecessorEndDateKey: predecessorEndKey,
        successorTemplateId: null,
        affectedClassCount: result.cancelledCount,
        affectedReservationCount: impact.totalReservations,
        cancelledBookingCount: result.cancelledBookingCount,
        expiredWaitlistCount: result.expiredWaitlistCount,
        cancelReason: cancelReason ?? null,
      },
    });

    return { cancelledCount: result.cancelledCount };
  }

  private async cancelEntireSeries(
    studio: { id: string; timezone: string },
    occurrence: Awaited<ReturnType<typeof this.requireOccurrence>>,
    actorUserId: string,
    cancelReason: string | undefined,
    impact: MutationImpact,
  ) {
    const tpl = occurrence.scheduleTemplate!;
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.scheduleTemplate.update({
        where: { id: tpl.id },
        data: { active: false, endsAt: now },
      });

      // Explicit entire-series cancellation includes DETACHED future rows intentionally.
      const toCancel = await tx.scheduledClass.findMany({
        where: {
          studioId: studio.id,
          scheduleTemplateId: tpl.id,
          startsAt: { gte: now },
          status: ClassStatus.SCHEDULED,
        },
        select: { id: true },
      });
      const ids = toCancel.map((row) => row.id);
      if (ids.length > 0) {
        await tx.scheduledClass.updateMany({
          where: { id: { in: ids } },
          data: {
            status: ClassStatus.CANCELLED,
            ...(cancelReason ? { cancelReason } : {}),
          },
        });
        const cascade = await cascadeClassCancellationInTx(tx, {
          studioId: studio.id,
          scheduledClassIds: ids,
        });
        return {
          cancelledCount: ids.length,
          cancelledBookingCount: cascade.cancelledBookingCount,
          expiredWaitlistCount: cascade.expiredWaitlistCount,
        };
      }
      return { cancelledCount: 0, cancelledBookingCount: 0, expiredWaitlistCount: 0 };
    });

    await this.audit.log({
      studioId: studio.id,
      actorUserId,
      action: 'SCHEDULE_ENTIRE_SERIES_CANCELLED',
      entityType: 'ScheduleTemplate',
      entityId: tpl.id,
      metadata: {
        scope: 'SERIES',
        previousTemplateId: tpl.id,
        includesDetachedOccurrences: true,
        affectedClassCount: result.cancelledCount,
        affectedReservationCount: impact.totalReservations,
        cancelledBookingCount: result.cancelledBookingCount,
        expiredWaitlistCount: result.expiredWaitlistCount,
        cancelReason: cancelReason ?? null,
      },
    });

    return { cancelledCount: result.cancelledCount };
  }

  private async buildOccurrenceUpdateData(
    timezone: string,
    occurrence: Awaited<ReturnType<typeof this.requireOccurrence>>,
    input: EditOccurrenceInput,
  ): Promise<Prisma.ScheduledClassUpdateInput> {
    const data: Prisma.ScheduledClassUpdateInput = {};
    if (input.localStart) {
      data.startsAt = studioLocalTimeToUtc(
        input.localStart.date,
        input.localStart.time,
        timezone,
      );
    }
    if (input.localEnd) {
      data.endsAt = studioLocalTimeToUtc(
        input.localEnd.date,
        input.localEnd.time,
        timezone,
      );
    } else if (input.localStart && occurrence.scheduleTemplate) {
      const startsAt = studioLocalTimeToUtc(
        input.localStart.date,
        input.localStart.time,
        timezone,
      );
      data.endsAt = new Date(
        startsAt.getTime() +
          occurrence.scheduleTemplate.classTemplate.durationMinutes * 60_000,
      );
    }
    if (data.startsAt instanceof Date || data.endsAt instanceof Date) {
      const nextStart = data.startsAt instanceof Date ? data.startsAt : occurrence.startsAt;
      const nextEnd = data.endsAt instanceof Date ? data.endsAt : occurrence.endsAt;
      assertStartsBeforeEnds(nextStart, nextEnd);
    }
    if (input.capacity !== undefined) data.capacity = input.capacity;
    if (input.instructorId !== undefined) {
      data.instructor = input.instructorId
        ? { connect: { id: input.instructorId } }
        : { disconnect: true };
    }
    return data;
  }

  private async resolveEditTargets(
    studioId: string,
    occurrence: Awaited<ReturnType<typeof this.requireOccurrence>>,
    scope: SeriesMutationScope,
  ) {
    if (scope === 'SINGLE') {
      return [{ id: occurrence.id }];
    }
    const now = new Date();
    if (scope === 'FOLLOWING') {
      return this.prisma.scheduledClass.findMany({
        where: {
          studioId,
          scheduleTemplateId: occurrence.scheduleTemplateId!,
          startsAt: { gte: occurrence.startsAt },
          status: ClassStatus.SCHEDULED,
        },
        select: { id: true },
      });
    }
    return this.prisma.scheduledClass.findMany({
      where: {
        studioId,
        scheduleTemplateId: occurrence.scheduleTemplateId!,
        startsAt: { gte: now },
        status: ClassStatus.SCHEDULED,
      },
      select: { id: true },
    });
  }

  private async computeEditImpact(
    studioId: string,
    occurrence: Awaited<ReturnType<typeof this.requireOccurrence>>,
    input: EditOccurrenceInput,
  ): Promise<MutationImpact> {
    const targets = await this.resolveEditTargets(studioId, occurrence, input.scope);
    return this.countReservationImpact(targets.map((t) => t.id));
  }

  private async computeCancelImpact(
    studioId: string,
    occurrence: Awaited<ReturnType<typeof this.requireOccurrence>>,
    scope: SeriesMutationScope,
  ): Promise<MutationImpact> {
    let ids: string[];
    if (scope === 'SINGLE') {
      ids = [occurrence.id];
    } else if (scope === 'FOLLOWING') {
      const rows = await this.prisma.scheduledClass.findMany({
        where: {
          studioId,
          scheduleTemplateId: occurrence.scheduleTemplateId ?? undefined,
          startsAt: { gte: occurrence.startsAt },
          status: ClassStatus.SCHEDULED,
        },
        select: { id: true },
      });
      ids = rows.map((r) => r.id);
    } else {
      const rows = await this.prisma.scheduledClass.findMany({
        where: {
          studioId,
          scheduleTemplateId: occurrence.scheduleTemplateId ?? undefined,
          startsAt: { gte: new Date() },
          status: ClassStatus.SCHEDULED,
        },
        select: { id: true },
      });
      ids = rows.map((r) => r.id);
    }
    return this.countReservationImpact(ids);
  }

  private async countReservationImpact(scheduledClassIds: string[]): Promise<MutationImpact> {
    if (scheduledClassIds.length === 0) {
      return { affectedClassCount: 0, classesWithReservations: 0, totalReservations: 0 };
    }
    const rows = await this.prisma.scheduledClass.findMany({
      where: { id: { in: scheduledClassIds } },
      select: {
        id: true,
        _count: {
          select: {
            bookings: { where: { status: BookingStatus.CONFIRMED } },
          },
        },
      },
    });
    let classesWithReservations = 0;
    let totalReservations = 0;
    for (const row of rows) {
      const n = row._count.bookings;
      if (n > 0) classesWithReservations++;
      totalReservations += n;
    }
    return {
      affectedClassCount: scheduledClassIds.length,
      classesWithReservations,
      totalReservations,
    };
  }

  private async buildEditSlots(
    studioId: string,
    occurrence: Awaited<ReturnType<typeof this.requireOccurrence>>,
    input: EditOccurrenceInput,
  ) {
    const studio = await this.requireStudio(studioId);
    const targets = await this.prisma.scheduledClass.findMany({
      where: {
        id: {
          in: (await this.resolveEditTargets(studioId, occurrence, input.scope)).map(
            (t) => t.id,
          ),
        },
      },
    });

    return targets.map((t) => {
      const startsAt = input.localStart
        ? studioLocalTimeToUtc(input.localStart.date, input.localStart.time, studio.timezone)
        : t.startsAt;
      let endsAt = t.endsAt;
      if (input.localEnd) {
        endsAt = studioLocalTimeToUtc(
          input.localEnd.date,
          input.localEnd.time,
          studio.timezone,
        );
      } else if (input.localStart && occurrence.scheduleTemplate) {
        endsAt = new Date(
          startsAt.getTime() +
            occurrence.scheduleTemplate.classTemplate.durationMinutes * 60_000,
        );
      }
      return {
        classTemplateId: t.classTemplateId,
        instructorId:
          input.instructorId !== undefined ? input.instructorId : t.instructorId,
        startsAt,
        endsAt,
        capacity: input.capacity ?? t.capacity,
        excludeScheduledClassId: t.id,
      };
    });
  }

  private hasRecurrenceFieldChanges(input: EditOccurrenceInput): boolean {
    return input.intervalWeeks !== undefined || input.endsOn !== undefined;
  }

  private async computeSeriesRecurrenceImpact(
    studio: { id: string; timezone: string },
    tpl: NonNullable<Awaited<ReturnType<typeof this.requireOccurrence>>['scheduleTemplate']>,
    input: EditOccurrenceInput,
  ): Promise<SeriesRecurrenceImpact> {
    const horizonDays = await this.getHorizonDays(studio.id);
    const futureRows = await this.loadFutureOccurrenceRows(studio.id, tpl.id);
    const plan = planSeriesRecurrenceReconciliation(
      { ...tpl, classTemplate: tpl.classTemplate },
      {
        intervalWeeks: input.intervalWeeks,
        endsOn: input.endsOn,
        startTime: input.localStart?.time,
        dayOfWeek: input.localStart
          ? getDayOfWeekFromDateKey(input.localStart.date)
          : undefined,
        capacity: input.capacity,
        instructorId: input.instructorId,
      },
      studio.timezone,
      horizonDays,
      futureRows,
    );
    return {
      keptCount: plan.keptCount,
      cancelledCount: plan.cancelledCount,
      materializeCount: plan.materializeCount,
      skippedDetachedCount: plan.skippedDetachedCount,
      skippedAttendanceCount: plan.skippedAttendanceCount,
      bookedOccurrencesAffected: plan.bookedCancellationCount,
      previousIntervalWeeks: plan.previousIntervalWeeks,
      newIntervalWeeks: plan.newIntervalWeeks,
      previousEndsOn: plan.previousEndsOn,
      newEndsOn: plan.newEndsOn,
    };
  }

  private async loadFutureOccurrenceRows(
    studioId: string,
    templateId: string,
  ): Promise<FutureOccurrenceRow[]> {
    const now = new Date();
    const rows = await this.prisma.scheduledClass.findMany({
      where: {
        studioId,
        scheduleTemplateId: templateId,
        startsAt: { gte: now },
      },
      select: {
        id: true,
        startsAt: true,
        status: true,
        exceptionKind: true,
        _count: {
          select: {
            bookings: { where: { status: BookingStatus.CONFIRMED } },
            attendances: true,
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      startsAt: row.startsAt,
      status: row.status,
      exceptionKind: row.exceptionKind,
      confirmedBookingCount: row._count.bookings,
      attendanceCount: row._count.attendances,
    }));
  }

  private async bookedIdsFromPlan(
    studioId: string,
    templateId: string,
    tpl: NonNullable<Awaited<ReturnType<typeof this.requireOccurrence>>['scheduleTemplate']>,
    input: EditOccurrenceInput,
    timezone: string,
  ): Promise<string[]> {
    const horizonDays = await this.getHorizonDays(studioId);
    const futureRows = await this.loadFutureOccurrenceRows(studioId, templateId);
    const plan = planSeriesRecurrenceReconciliation(
      { ...tpl, classTemplate: tpl.classTemplate },
      {
        intervalWeeks: input.intervalWeeks,
        endsOn: input.endsOn,
        startTime: input.localStart?.time,
        dayOfWeek: input.localStart
          ? getDayOfWeekFromDateKey(input.localStart.date)
          : undefined,
        capacity: input.capacity,
        instructorId: input.instructorId,
      },
      timezone,
      horizonDays,
      futureRows,
    );
    return plan.toCancelIds.filter((id) =>
      futureRows.some((r) => r.id === id && r.confirmedBookingCount > 0),
    );
  }

  private async resolveFinishBoundaryDateKey(
    studioId: string,
    templateId: string,
    timezone: string,
    input: FinishSeriesInput,
  ): Promise<string> {
    if (input.mode === 'ON_DATE') {
      if (!input.boundaryDate) {
        throw new BadRequestException('boundaryDate is required for ON_DATE finish mode.');
      }
      return input.boundaryDate;
    }

    const rows = await this.prisma.scheduledClass.findMany({
      where: { studioId, scheduleTemplateId: templateId, status: ClassStatus.SCHEDULED },
      select: { startsAt: true, status: true },
      orderBy: { startsAt: 'desc' },
    });
    const lastKey = lastScheduledLocalDateKey(rows, timezone);
    if (!lastKey) {
      throw new BadRequestException('No scheduled classes exist to determine series boundary.');
    }
    return lastKey;
  }

  private async assertActiveStudioMember(studioId: string, userId: string) {
    const row = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId, deletedAt: null },
      include: { user: { select: { deletedAt: true } } },
    });
    if (!row || row.user.deletedAt) {
      throw new BadRequestException('instructorId must be an active member of this studio');
    }
  }
}
