import {
  ClassStatus,
  ScheduleOccurrenceExceptionKind,
  type Prisma,
} from '@prisma/client';
import type { WeekReconciliationPlan } from './schedule-week-reconciliation';
import { duplicateWeekCreateFields, type DuplicateWeekSeriesDesired } from './schedule-week-series-linkage';

export const WEEK_RECONCILIATION_TX_OPTIONS = {
  /** Max wait to acquire a connection for the interactive transaction. */
  maxWait: 10_000,
  /** Bounded timeout after batching; normal workloads finish well below this. */
  timeout: 60_000,
} as const;

export const WEEK_RECONCILIATION_REMOVE_CANCEL_REASON =
  'Removed by week reconciliation';

/** Cap IDs stored in audit metadata to keep payloads bounded. */
export const WEEK_RECONCILIATION_AUDIT_ID_CAP = 200;

const CREATE_BATCH_SIZE = 500;
const UPDATE_BATCH_SIZE = 100;

export type WeekReconciliationApplyResult = {
  affectedClassIds: string[];
  createdCount: number;
  updatedCount: number;
  removedCount: number;
  reusedCount: number;
};

function patchGroupKey(data: Prisma.ScheduledClassUpdateInput): string {
  return JSON.stringify(data, (_key, value) =>
    value instanceof Date ? value.toISOString() : value,
  );
}

/** Apply a week reconciliation plan with bounded DB round trips. */
export async function applyWeekReconciliationPlanBatched(
  tx: Prisma.TransactionClient,
  studioId: string,
  plan: WeekReconciliationPlan,
): Promise<WeekReconciliationApplyResult> {
  const createRows: Prisma.ScheduledClassCreateManyInput[] = [];
  const removePlainIds: string[] = [];
  const removeDetachedIds: string[] = [];
  const updates: Array<{ id: string; data: Prisma.ScheduledClassUpdateInput }> = [];
  const reusedIds: string[] = [];

  for (const action of plan.actions) {
    switch (action.kind) {
      case 'REUSE':
        if (action.existingId) reusedIds.push(action.existingId);
        break;
      case 'UPDATE':
        if (action.existingId && action.patch) {
          updates.push({ id: action.existingId, data: action.patch });
        }
        break;
      case 'CREATE':
        if (action.slot) {
          const seriesFields = duplicateWeekCreateFields(action.slot as DuplicateWeekSeriesDesired);
          createRows.push({
            studioId,
            classTemplateId: action.slot.classTemplateId,
            instructorId: action.slot.instructorId,
            startsAt: action.slot.startsAt,
            endsAt: action.slot.endsAt,
            capacity: action.slot.capacity,
            status: ClassStatus.SCHEDULED,
            scheduleTemplateId: seriesFields.scheduleTemplateId,
            exceptionKind: seriesFields.exceptionKind,
          });
        }
        break;
      case 'REMOVE':
        if (action.existingId) {
          if (action.patch?.exceptionKind === ScheduleOccurrenceExceptionKind.DETACHED) {
            removeDetachedIds.push(action.existingId);
          } else {
            removePlainIds.push(action.existingId);
          }
        }
        break;
      default:
        break;
    }
  }

  const createdIds: string[] = [];
  for (let i = 0; i < createRows.length; i += CREATE_BATCH_SIZE) {
    const chunk = createRows.slice(i, i + CREATE_BATCH_SIZE);
    const rows = await tx.scheduledClass.createManyAndReturn({
      data: chunk,
      skipDuplicates: true,
      select: { id: true },
    });
    createdIds.push(...rows.map((row) => row.id));
  }

  if (removePlainIds.length > 0) {
    await tx.scheduledClass.updateMany({
      where: { id: { in: removePlainIds }, studioId },
      data: {
        status: ClassStatus.CANCELLED,
        cancelReason: WEEK_RECONCILIATION_REMOVE_CANCEL_REASON,
      },
    });
  }

  if (removeDetachedIds.length > 0) {
    await tx.scheduledClass.updateMany({
      where: { id: { in: removeDetachedIds }, studioId },
      data: {
        status: ClassStatus.CANCELLED,
        cancelReason: WEEK_RECONCILIATION_REMOVE_CANCEL_REASON,
        exceptionKind: ScheduleOccurrenceExceptionKind.DETACHED,
      },
    });
  }

  const updatesByPatch = new Map<
    string,
    { ids: string[]; data: Prisma.ScheduledClassUpdateInput }
  >();
  for (const update of updates) {
    const key = patchGroupKey(update.data);
    const group = updatesByPatch.get(key);
    if (group) {
      group.ids.push(update.id);
    } else {
      updatesByPatch.set(key, { ids: [update.id], data: update.data });
    }
  }

  let updatedCount = 0;
  const updatedIds: string[] = [];
  for (const group of updatesByPatch.values()) {
    for (let i = 0; i < group.ids.length; i += UPDATE_BATCH_SIZE) {
      const idBatch = group.ids.slice(i, i + UPDATE_BATCH_SIZE);
      await tx.scheduledClass.updateMany({
        where: { id: { in: idBatch }, studioId },
        data: group.data,
      });
      updatedIds.push(...idBatch);
      updatedCount += idBatch.length;
    }
  }

  return {
    affectedClassIds: [
      ...reusedIds,
      ...createdIds,
      ...removePlainIds,
      ...removeDetachedIds,
      ...updatedIds,
    ],
    createdCount: createdIds.length,
    updatedCount,
    removedCount: removePlainIds.length + removeDetachedIds.length,
    reusedCount: reusedIds.length,
  };
}

export function boundedAuditClassIds(ids: string[]): {
  affectedClassIds: string[];
  affectedClassIdsTruncated: boolean;
  affectedClassCount: number;
} {
  if (ids.length <= WEEK_RECONCILIATION_AUDIT_ID_CAP) {
    return {
      affectedClassIds: ids,
      affectedClassIdsTruncated: false,
      affectedClassCount: ids.length,
    };
  }
  return {
    affectedClassIds: ids.slice(0, WEEK_RECONCILIATION_AUDIT_ID_CAP),
    affectedClassIdsTruncated: true,
    affectedClassCount: ids.length,
  };
}
