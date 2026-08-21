import { ClassStatus, ScheduleOccurrenceExceptionKind } from '@prisma/client';
import {
  addDaysToDateKey,
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
  studioLocalTimeToUtc,
} from '../common/date/studio-local-date';
import {
  buildCandidatesForTemplateInRange,
  indexExistingOccurrences,
  isLegacyUnboundedTemplate,
  isTemplateActiveOnDateKey,
  MaterializableTemplate,
  shouldSkipCandidate,
  templateEffectiveEndKey,
  templateEffectiveStartKey,
} from './schedule-materialization';

export type FutureOccurrenceRow = {
  id: string;
  startsAt: Date;
  status: ClassStatus;
  exceptionKind: ScheduleOccurrenceExceptionKind | null;
  confirmedBookingCount: number;
  attendanceCount: number;
};

export type ProposedSeriesRecurrence = {
  intervalWeeks?: number;
  /** undefined = unchanged, null = unbounded, string = inclusive local end date */
  endsOn?: string | null;
  startTime?: string;
  dayOfWeek?: number;
  capacity?: number;
  instructorId?: string | null;
};

export type SeriesRecurrenceReconcilePlan = {
  keptCount: number;
  cancelledCount: number;
  materializeCount: number;
  skippedDetachedCount: number;
  skippedAttendanceCount: number;
  bookedCancellationCount: number;
  toUpdateIds: string[];
  toCancelIds: string[];
  materializeDateKeys: string[];
  previousIntervalWeeks: number;
  newIntervalWeeks: number;
  previousEndsOn: string | null;
  newEndsOn: string | null;
};

export function computeMaterializationEndKey(
  startsOn: string,
  endsOn: string | null | undefined,
  horizonDays: number,
  timezone: string,
  at: Date = new Date(),
): string {
  const horizonEnd = addDaysToDateKey(getStudioLocalDateKey(at, timezone), horizonDays);
  if (!endsOn) return horizonEnd;
  return endsOn < horizonEnd ? endsOn : horizonEnd;
}

export function resolveProposedTemplate(
  template: MaterializableTemplate,
  proposed: ProposedSeriesRecurrence,
  timezone: string,
): MaterializableTemplate {
  const endsAt =
    proposed.endsOn === undefined
      ? template.endsAt
      : proposed.endsOn === null
        ? null
        : studioLocalDateKeyToUtcAnchor(proposed.endsOn, timezone);

  return {
    ...template,
    dayOfWeek: proposed.dayOfWeek ?? template.dayOfWeek,
    startTime: proposed.startTime ?? template.startTime,
    capacity: proposed.capacity ?? template.capacity,
    instructorId:
      proposed.instructorId !== undefined ? proposed.instructorId : template.instructorId,
    intervalWeeks: proposed.intervalWeeks ?? template.intervalWeeks,
    endsAt,
    // Legacy startsAt must never be invented by recurrence edits.
    startsAt: template.startsAt,
  };
}

export function planSeriesRecurrenceReconciliation(
  template: MaterializableTemplate,
  proposed: ProposedSeriesRecurrence,
  timezone: string,
  horizonDays: number,
  futureRows: FutureOccurrenceRow[],
  at: Date = new Date(),
): SeriesRecurrenceReconcilePlan {
  const previousEndsOn = templateEffectiveEndKey(template, timezone);
  const updatedTemplate = resolveProposedTemplate(template, proposed, timezone);
  const newEndsOn = templateEffectiveEndKey(updatedTemplate, timezone);
  const previousIntervalWeeks = template.intervalWeeks ?? 1;
  const newIntervalWeeks = updatedTemplate.intervalWeeks ?? 1;

  const nowKey = getStudioLocalDateKey(at, timezone);
  const startKey = templateEffectiveStartKey(updatedTemplate, timezone);
  const rangeStart = startKey > nowKey ? startKey : nowKey;
  const endKey = computeMaterializationEndKey(
    rangeStart,
    newEndsOn,
    horizonDays,
    timezone,
    at,
  );
  const toExclusive = addDaysToDateKey(endKey, 1);

  const candidates = buildCandidatesForTemplateInRange(
    updatedTemplate,
    timezone,
    rangeStart,
    toExclusive,
  );
  const candidateDateKeys = new Set(candidates.map((c) => c.localDateKey));

  const existingByDateKey = new Map<string, FutureOccurrenceRow[]>();
  for (const row of futureRows) {
    if (row.status !== ClassStatus.SCHEDULED) continue;
    const dateKey = getStudioLocalDateKey(row.startsAt, timezone);
    const arr = existingByDateKey.get(dateKey) ?? [];
    arr.push(row);
    existingByDateKey.set(dateKey, arr);
  }

  const toUpdateIds: string[] = [];
  const toCancelIds: string[] = [];
  let keptCount = 0;
  let cancelledCount = 0;
  let skippedDetachedCount = 0;
  let skippedAttendanceCount = 0;
  let bookedCancellationCount = 0;

  for (const row of futureRows) {
    if (row.startsAt < at) continue;
    if (row.status !== ClassStatus.SCHEDULED) continue;

    const dateKey = getStudioLocalDateKey(row.startsAt, timezone);
    if (row.exceptionKind === ScheduleOccurrenceExceptionKind.DETACHED) {
      skippedDetachedCount++;
      continue;
    }
    if (row.attendanceCount > 0) {
      skippedAttendanceCount++;
      continue;
    }

    const stillActive =
      candidateDateKeys.has(dateKey) &&
      isTemplateActiveOnDateKey(updatedTemplate, dateKey, timezone);

    if (stillActive) {
      toUpdateIds.push(row.id);
      keptCount++;
    } else {
      toCancelIds.push(row.id);
      cancelledCount++;
      if (row.confirmedBookingCount > 0) bookedCancellationCount++;
    }
  }

  const materializeDateKeys: string[] = [];
  for (const dateKey of candidateDateKeys) {
    const existing = existingByDateKey.get(dateKey) ?? [];
    const occupied = existing.some(
      (row) =>
        row.exceptionKind === ScheduleOccurrenceExceptionKind.DETACHED ||
        row.status === ClassStatus.SCHEDULED ||
        row.status === ClassStatus.CANCELLED,
    );
    if (!occupied) materializeDateKeys.push(dateKey);
  }

  return {
    keptCount,
    cancelledCount,
    materializeCount: materializeDateKeys.length,
    skippedDetachedCount,
    skippedAttendanceCount,
    bookedCancellationCount,
    toUpdateIds,
    toCancelIds,
    materializeDateKeys,
    previousIntervalWeeks,
    newIntervalWeeks,
    previousEndsOn,
    newEndsOn,
  };
}

export function lastScheduledLocalDateKey(
  rows: Array<{ startsAt: Date; status: ClassStatus }>,
  timezone: string,
): string | null {
  let maxKey: string | null = null;
  for (const row of rows) {
    if (row.status !== ClassStatus.SCHEDULED) continue;
    const key = getStudioLocalDateKey(row.startsAt, timezone);
    if (!maxKey || key > maxKey) maxKey = key;
  }
  return maxKey;
}

export function planFinishSeriesBoundary(
  template: MaterializableTemplate,
  timezone: string,
  boundaryDateKey: string,
  futureRows: FutureOccurrenceRow[],
  at: Date = new Date(),
): {
  boundaryDateKey: string;
  cancelIds: string[];
  cancelledCount: number;
  bookedCancellationCount: number;
  skippedDetachedCount: number;
} {
  const cancelIds: string[] = [];
  let cancelledCount = 0;
  let bookedCancellationCount = 0;
  let skippedDetachedCount = 0;

  for (const row of futureRows) {
    if (row.startsAt < at) continue;
    if (row.status !== ClassStatus.SCHEDULED) continue;
    const dateKey = getStudioLocalDateKey(row.startsAt, timezone);
    if (dateKey <= boundaryDateKey) continue;
    if (row.exceptionKind === ScheduleOccurrenceExceptionKind.DETACHED) {
      skippedDetachedCount++;
    }
    cancelIds.push(row.id);
    cancelledCount++;
    if (row.confirmedBookingCount > 0) bookedCancellationCount++;
  }

  return {
    boundaryDateKey,
    cancelIds,
    cancelledCount,
    bookedCancellationCount,
    skippedDetachedCount,
  };
}

export function indexExistingForMaterialize(
  existing: Array<{
    classTemplateId: string;
    startsAt: Date;
    scheduleTemplateId: string | null;
    status: ClassStatus;
  }>,
  timezone: string,
) {
  return indexExistingOccurrences(existing, timezone);
}

export function filterMaterializeCandidates<T extends { localDateKey: string }>(
  candidates: T[],
  dedupKeys: Set<string>,
  templateDateKeys: Set<string>,
): T[] {
  return candidates.filter((c) => !shouldSkipCandidate(c as never, dedupKeys, templateDateKeys));
}

export function legacyStartsAtMustRemainNull(
  before: MaterializableTemplate,
  after: MaterializableTemplate,
): boolean {
  if (!isLegacyUnboundedTemplate(before)) return true;
  return after.startsAt === null;
}

export function occurrenceStartsAtForDateKey(
  template: MaterializableTemplate,
  dateKey: string,
  timezone: string,
): Date {
  return studioLocalTimeToUtc(dateKey, template.startTime, timezone);
}

export function occurrenceEndsAtForDateKey(
  template: MaterializableTemplate,
  dateKey: string,
  timezone: string,
): Date {
  const startsAt = occurrenceStartsAtForDateKey(template, dateKey, timezone);
  return new Date(startsAt.getTime() + template.classTemplate.durationMinutes * 60_000);
}
