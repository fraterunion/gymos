import { ScheduleOccurrenceExceptionKind } from '@prisma/client';
import {
  getStudioLocalDateKey,
  getStudioLocalHHmm,
  studioLocalTimeToUtc,
} from '../common/date/studio-local-date';
import {
  isTemplateActiveOnDateKey,
  type MaterializableTemplate,
} from './schedule-materialization';
import type { DesiredWeekSlot, ExistingWeekRow, WeekReconciliationAction, WeekReconciliationPlan } from './schedule-week-reconciliation';

export type DuplicateWeekTemplateRef = {
  id: string;
  classTemplateId: string;
  dayOfWeek: number;
  startTime: string;
  intervalWeeks: number;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
};

export type DuplicateWeekSeriesDesired = DesiredWeekSlot;

function toMaterializable(template: DuplicateWeekTemplateRef): MaterializableTemplate {
  return {
    id: template.id,
    classTemplateId: template.classTemplateId,
    instructorId: null,
    dayOfWeek: template.dayOfWeek,
    startTime: template.startTime,
    capacity: null,
    intervalWeeks: template.intervalWeeks,
    startsAt: template.startsAt,
    endsAt: template.endsAt,
    classTemplate: {
      id: template.classTemplateId,
      name: '',
      durationMinutes: 60,
      defaultCapacity: 12,
    },
  };
}

export type DuplicateWeekSeriesLinkageResult = {
  desiredScheduleTemplateId: string | null;
  detachedOffCadenceCopy: boolean;
  reason: string;
};

/**
 * Calendar 2.4.1 duplicate-week series linkage semantics.
 *
 * CASE 1: linked source + valid cadence target → same scheduleTemplateId
 * CASE 2: linked source + off-cadence target → standalone + DETACHED
 * CASE 3: standalone source → standalone target
 */
export function resolveDuplicateWeekTargetLinkage(
  slot: Pick<DuplicateWeekSeriesDesired, 'startsAt' | 'classTemplateId' | 'sourceScheduleTemplateId'>,
  templates: DuplicateWeekTemplateRef[],
  timezone: string,
): DuplicateWeekSeriesLinkageResult {
  const sourceTemplateId = slot.sourceScheduleTemplateId ?? null;
  if (!sourceTemplateId) {
    return {
      desiredScheduleTemplateId: null,
      detachedOffCadenceCopy: false,
      reason: 'CASE_3_STANDALONE_SOURCE',
    };
  }

  const template = templates.find((t) => t.id === sourceTemplateId && t.active);
  if (!template) {
    return {
      desiredScheduleTemplateId: null,
      detachedOffCadenceCopy: false,
      reason: 'SOURCE_TEMPLATE_INACTIVE_OR_MISSING',
    };
  }

  const localDateKey = getStudioLocalDateKey(slot.startsAt, timezone);
  const localTime = getStudioLocalHHmm(slot.startsAt, timezone);

  if (template.classTemplateId !== slot.classTemplateId) {
    return {
      desiredScheduleTemplateId: null,
      detachedOffCadenceCopy: false,
      reason: 'SOURCE_TEMPLATE_CLASS_MISMATCH',
    };
  }

  if (localTime !== template.startTime) {
    return {
      desiredScheduleTemplateId: null,
      detachedOffCadenceCopy: true,
      reason: 'CASE_2_OFF_CADENCE_TIME',
    };
  }

  const expectedStartsAt = studioLocalTimeToUtc(localDateKey, template.startTime, timezone);
  if (expectedStartsAt.getTime() !== slot.startsAt.getTime()) {
    return {
      desiredScheduleTemplateId: null,
      detachedOffCadenceCopy: true,
      reason: 'CASE_2_OFF_CADENCE_STARTS_AT',
    };
  }

  if (!isTemplateActiveOnDateKey(toMaterializable(template), localDateKey, timezone)) {
    return {
      desiredScheduleTemplateId: null,
      detachedOffCadenceCopy: true,
      reason: 'CASE_2_OFF_CADENCE_RECURRENCE',
    };
  }

  return {
    desiredScheduleTemplateId: sourceTemplateId,
    detachedOffCadenceCopy: false,
    reason: 'CASE_1_LINKED_VALID_CADENCE',
  };
}

export function enrichDuplicateWeekSlotsWithSeriesLinkage(
  slots: DuplicateWeekSeriesDesired[],
  templates: DuplicateWeekTemplateRef[],
  timezone: string,
): DuplicateWeekSeriesDesired[] {
  return slots.map((slot) => {
    const resolved = resolveDuplicateWeekTargetLinkage(slot, templates, timezone);
    return {
      ...slot,
      desiredScheduleTemplateId: resolved.desiredScheduleTemplateId,
      detachedOffCadenceCopy: resolved.detachedOffCadenceCopy,
    };
  });
}


/**
 * Post-process a week reconciliation plan to enforce series linkage semantics.
 *
 * CASE 4: existing linked correctly → REUSE (unchanged)
 * CASE 5: existing standalone + deterministic match → UPDATE scheduleTemplateId in-place
 * CASE 6: existing linked to different template → BLOCK
 */
export function applyDuplicateWeekSeriesLinkageToPlan(
  plan: WeekReconciliationPlan,
  existingRows: ExistingWeekRow[],
): WeekReconciliationPlan {
  const existingById = new Map(existingRows.map((r) => [r.id, r]));
  const actions: WeekReconciliationAction[] = [];
  let blockedCount = plan.blockedCount;
  let updatedCount = plan.updatedCount;
  let reviewCount = plan.reviewCount;

  for (const action of plan.actions) {
    const slot = action.slot as DuplicateWeekSeriesDesired | undefined;
    const desiredTemplateId = slot?.desiredScheduleTemplateId ?? null;
    const detachedCopy = slot?.detachedOffCadenceCopy ?? false;

    if (action.kind === 'CREATE' && slot) {
      actions.push({
        ...action,
        slot: {
          ...slot,
          desiredScheduleTemplateId: desiredTemplateId,
          detachedOffCadenceCopy: detachedCopy,
        },
      });
      continue;
    }

    if (
      (action.kind === 'REUSE' || action.kind === 'UPDATE') &&
      action.existingId &&
      slot
    ) {
      const existing = existingById.get(action.existingId);
      if (!existing) {
        actions.push(action);
        continue;
      }

      const existingTemplateId = existing.scheduleTemplateId ?? null;

      if (
        existingTemplateId &&
        desiredTemplateId &&
        existingTemplateId !== desiredTemplateId
      ) {
        blockedCount++;
        actions.push({
          kind: 'BLOCK',
          existingId: existing.id,
          slot,
          bookingCount: existing.bookingCount,
          message: `Target occurrence is linked to a different series (${existingTemplateId}); cannot reconcile.`,
        });
        continue;
      }

      if (existingTemplateId && desiredTemplateId && existingTemplateId === desiredTemplateId) {
        actions.push(action);
        continue;
      }

      if (!existingTemplateId && desiredTemplateId && action.kind === 'REUSE') {
        updatedCount++;
        actions.push({
          kind: 'UPDATE',
          existingId: existing.id,
          slot,
          bookingCount: existing.bookingCount,
          patch: { scheduleTemplateId: desiredTemplateId },
        });
        continue;
      }

      if (!existingTemplateId && desiredTemplateId && action.kind === 'UPDATE') {
        actions.push({
          ...action,
          patch: {
            ...action.patch,
            scheduleTemplateId: desiredTemplateId,
          },
        });
        continue;
      }

      if (existingTemplateId && !desiredTemplateId && detachedCopy) {
        reviewCount++;
        actions.push({
          kind: 'REVIEW',
          existingId: existing.id,
          slot,
          bookingCount: existing.bookingCount,
          message: 'Existing linked occurrence conflicts with off-cadence detached copy intent.',
        });
        continue;
      }

      actions.push(action);
      continue;
    }

    actions.push(action);
  }

  return {
    ...plan,
    actions,
    blockedCount,
    updatedCount,
    reviewCount,
  };
}

export function duplicateWeekCreateFields(
  slot: DuplicateWeekSeriesDesired,
): {
  scheduleTemplateId: string | null;
  exceptionKind: ScheduleOccurrenceExceptionKind | null;
} {
  if (slot.detachedOffCadenceCopy) {
    return {
      scheduleTemplateId: null,
      exceptionKind: ScheduleOccurrenceExceptionKind.DETACHED,
    };
  }
  return {
    scheduleTemplateId: slot.desiredScheduleTemplateId ?? null,
    exceptionKind: null,
  };
}
