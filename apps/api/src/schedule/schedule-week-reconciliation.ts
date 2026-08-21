import { ClassStatus, ScheduleOccurrenceExceptionKind } from '@prisma/client';
import { occurrenceDedupKey } from './schedule-occurrence-key';

export type DesiredWeekSlot = {
  classTemplateId: string;
  classTemplateName?: string;
  instructorId: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  localDateKey: string;
  targetWeekStart: string;
  sourceScheduledClassId?: string;
};

export type ExistingWeekRow = {
  id: string;
  classTemplateId: string;
  instructorId: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  status: ClassStatus;
  scheduleTemplateId: string | null;
  exceptionKind: ScheduleOccurrenceExceptionKind | null;
  bookingCount: number;
  attendanceCount: number;
  waitlistCount: number;
  classTemplateName: string;
  instructorFirstName?: string | null;
  instructorLastName?: string | null;
};

export type WeekReconciliationActionKind =
  | 'REUSE'
  | 'CREATE'
  | 'UPDATE'
  | 'REMOVE'
  | 'REVIEW'
  | 'BLOCK';

export type WeekReconciliationAction = {
  kind: WeekReconciliationActionKind;
  existingId?: string;
  slot?: DesiredWeekSlot;
  bookingCount?: number;
  attendanceCount?: number;
  waitlistCount?: number;
  message?: string;
  patch?: {
    instructorId?: string | null;
    capacity?: number;
    endsAt?: Date;
    status?: ClassStatus;
    exceptionKind?: ScheduleOccurrenceExceptionKind | null;
    cancelReason?: string | null;
  };
};

export type WeekReconciliationPlan = {
  actions: WeekReconciliationAction[];
  reusedCount: number;
  createdCount: number;
  updatedCount: number;
  removedCount: number;
  reviewCount: number;
  blockedCount: number;
  affectedReservationCount: number;
};

function slotsEquivalent(existing: ExistingWeekRow, desired: DesiredWeekSlot): boolean {
  return (
    existing.instructorId === desired.instructorId &&
    existing.capacity === desired.capacity &&
    existing.endsAt.getTime() === desired.endsAt.getTime()
  );
}

function hasOperationalHistory(row: ExistingWeekRow): boolean {
  return row.bookingCount > 0 || row.attendanceCount > 0 || row.waitlistCount > 0;
}

function buildUpdatePatch(
  existing: ExistingWeekRow,
  desired: DesiredWeekSlot,
): WeekReconciliationAction['patch'] {
  const patch: NonNullable<WeekReconciliationAction['patch']> = {};
  if (existing.instructorId !== desired.instructorId) {
    patch.instructorId = desired.instructorId;
  }
  if (existing.capacity !== desired.capacity) {
    patch.capacity = desired.capacity;
  }
  if (existing.endsAt.getTime() !== desired.endsAt.getTime()) {
    patch.endsAt = desired.endsAt;
  }
  if (existing.status !== ClassStatus.SCHEDULED) {
    patch.status = ClassStatus.SCHEDULED;
    patch.cancelReason = null;
  }
  if (existing.scheduleTemplateId) {
    patch.exceptionKind = ScheduleOccurrenceExceptionKind.DETACHED;
  }
  return patch;
}

/** Pure reconciliation: source week desired schedule vs current target-week rows. */
export function buildWeekReconciliationPlan(
  desiredSlots: DesiredWeekSlot[],
  existingRows: ExistingWeekRow[],
  now: Date = new Date(),
): WeekReconciliationPlan {
  const actions: WeekReconciliationAction[] = [];
  const scheduledRows = existingRows.filter((r) => r.status === ClassStatus.SCHEDULED);
  const cancelledByKey = new Map<string, ExistingWeekRow>();
  for (const row of existingRows) {
    if (row.status !== ClassStatus.CANCELLED) continue;
    cancelledByKey.set(occurrenceDedupKey(row.classTemplateId, row.startsAt), row);
  }

  const scheduledByKey = new Map<string, ExistingWeekRow>();
  for (const row of scheduledRows) {
    scheduledByKey.set(occurrenceDedupKey(row.classTemplateId, row.startsAt), row);
  }

  const matchedIds = new Set<string>();
  let reusedCount = 0;
  let createdCount = 0;
  let updatedCount = 0;
  let removedCount = 0;
  let reviewCount = 0;
  let blockedCount = 0;
  let affectedReservationCount = 0;

  for (const slot of desiredSlots) {
    const key = occurrenceDedupKey(slot.classTemplateId, slot.startsAt);
    const existing = scheduledByKey.get(key) ?? cancelledByKey.get(key);

    if (existing && existing.status === ClassStatus.SCHEDULED) {
      matchedIds.add(existing.id);
      if (slotsEquivalent(existing, slot)) {
        reusedCount++;
        actions.push({ kind: 'REUSE', existingId: existing.id, slot });
      } else {
        if (slot.capacity < existing.bookingCount) {
          blockedCount++;
          actions.push({
            kind: 'BLOCK',
            existingId: existing.id,
            slot,
            bookingCount: existing.bookingCount,
            message: `Class has ${existing.bookingCount} confirmed booking(s); capacity ${slot.capacity} is too low.`,
          });
          continue;
        }
        updatedCount++;
        if (existing.bookingCount > 0) {
          affectedReservationCount += existing.bookingCount;
        }
        actions.push({
          kind: 'UPDATE',
          existingId: existing.id,
          slot,
          bookingCount: existing.bookingCount,
          patch: buildUpdatePatch(existing, slot),
        });
      }
      continue;
    }

    if (existing && existing.status === ClassStatus.CANCELLED) {
      matchedIds.add(existing.id);
      if (hasOperationalHistory(existing)) {
        blockedCount++;
        actions.push({
          kind: 'BLOCK',
          existingId: existing.id,
          slot,
          bookingCount: existing.bookingCount,
          attendanceCount: existing.attendanceCount,
          waitlistCount: existing.waitlistCount,
          message:
            'Cannot reactivate a cancelled class with operational history; resolve manually.',
        });
        continue;
      }
      if (slotsEquivalent(existing, slot)) {
        updatedCount++;
        actions.push({
          kind: 'UPDATE',
          existingId: existing.id,
          slot,
          patch: {
            status: ClassStatus.SCHEDULED,
            cancelReason: null,
          },
        });
      } else {
        updatedCount++;
        actions.push({
          kind: 'UPDATE',
          existingId: existing.id,
          slot,
          patch: {
            ...buildUpdatePatch({ ...existing, status: ClassStatus.CANCELLED }, slot),
            status: ClassStatus.SCHEDULED,
            cancelReason: null,
          },
        });
      }
      continue;
    }

    createdCount++;
    actions.push({ kind: 'CREATE', slot });
  }

  for (const row of scheduledRows) {
    if (matchedIds.has(row.id)) continue;

    if (hasOperationalHistory(row)) {
      if (row.attendanceCount > 0) {
        blockedCount++;
        actions.push({
          kind: 'BLOCK',
          existingId: row.id,
          bookingCount: row.bookingCount,
          attendanceCount: row.attendanceCount,
          waitlistCount: row.waitlistCount,
          message: 'Cannot remove a class with attendance history.',
        });
      } else {
        reviewCount++;
        affectedReservationCount += row.bookingCount;
        actions.push({
          kind: 'REVIEW',
          existingId: row.id,
          bookingCount: row.bookingCount,
          waitlistCount: row.waitlistCount,
          message: `Extra class not in source week (${row.bookingCount} reservation(s)).`,
        });
      }
      continue;
    }

    if (row.startsAt <= now) {
      blockedCount++;
      actions.push({
        kind: 'BLOCK',
        existingId: row.id,
        message: 'Cannot remove a class that has already started.',
      });
      continue;
    }

    removedCount++;
    actions.push({
      kind: 'REMOVE',
      existingId: row.id,
      patch: {
        status: ClassStatus.CANCELLED,
        cancelReason: 'Removed by week reconciliation',
        ...(row.scheduleTemplateId
          ? { exceptionKind: ScheduleOccurrenceExceptionKind.DETACHED }
          : {}),
      },
    });
  }

  return {
    actions,
    reusedCount,
    createdCount,
    updatedCount,
    removedCount,
    reviewCount,
    blockedCount,
    affectedReservationCount,
  };
}

export function planToOperationCounts(plan: WeekReconciliationPlan) {
  return {
    proposedCount: plan.actions.filter((a) => a.kind !== 'BLOCK').length,
    createdCount: plan.createdCount,
    updatedCount: plan.updatedCount,
    cancelledCount: plan.removedCount,
    reusedCount: plan.reusedCount,
    removedCount: plan.removedCount,
    reviewCount: plan.reviewCount,
    blockedCount: plan.blockedCount,
    affectedReservationCount: plan.affectedReservationCount,
  };
}
