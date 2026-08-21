import type { ScheduleConflict } from './schedule-conflicts.service';

/** Unified preview/execute result for Calendar 2.2 schedule operations. */
export type ScheduleOperationResult = {
  proposedCount: number;
  createdCount: number;
  updatedCount: number;
  cancelledCount: number;
  skippedCount: number;
  /** Idempotent skip: canonical slot already occupied (not an error). */
  skippedAlreadyExistsCount: number;
  /** Week reconciliation: existing row matches desired config exactly. */
  reusedCount: number;
  /** Week reconciliation: empty extra classes soft-cancelled. */
  removedCount: number;
  /** Week reconciliation: extras with reservations requiring manual review. */
  reviewCount: number;
  warningCount: number;
  blockedCount: number;
  affectedReservationCount: number;
  conflicts: ScheduleConflict[];
  affectedClassIds: string[];
  idempotentReplay?: boolean;
  reconciliationItems?: ScheduleReconciliationItem[];
};

export type ScheduleReconciliationItem = {
  kind: 'CREATE' | 'REUSE' | 'UPDATE' | 'REMOVE' | 'REVIEW' | 'BLOCK';
  scheduledClassId?: string;
  classTemplateName?: string;
  localDateKey?: string;
  startTime?: string;
  dateLabel?: string;
  timeLabel?: string;
  actionLabel?: string;
  detail?: string;
  bookingCount?: number;
  message?: string;
};

export function emptyOperationResult(
  overrides: Partial<ScheduleOperationResult> = {},
): ScheduleOperationResult {
  return {
    proposedCount: 0,
    createdCount: 0,
    updatedCount: 0,
    cancelledCount: 0,
    skippedCount: 0,
    skippedAlreadyExistsCount: 0,
    reusedCount: 0,
    removedCount: 0,
    reviewCount: 0,
    warningCount: 0,
    blockedCount: 0,
    affectedReservationCount: 0,
    conflicts: [],
    affectedClassIds: [],
    ...overrides,
  };
}

export function buildPreviewResult(input: {
  proposedCount: number;
  conflicts: ScheduleConflict[];
  classesWithReservations?: number;
  totalReservations?: number;
}): ScheduleOperationResult {
  const duplicateBlocks = input.conflicts.filter(
    (c) => c.severity === 'BLOCKING' && c.kind === 'DUPLICATE_OCCURRENCE',
  );
  const hardBlocks = input.conflicts.filter(
    (c) => c.severity === 'BLOCKING' && c.kind !== 'DUPLICATE_OCCURRENCE',
  );
  const warnings = input.conflicts.filter((c) => c.severity === 'WARNING');

  return emptyOperationResult({
    proposedCount: input.proposedCount,
    createdCount: input.proposedCount - duplicateBlocks.length,
    skippedCount: duplicateBlocks.length,
    skippedAlreadyExistsCount: duplicateBlocks.length,
    blockedCount: hardBlocks.length,
    warningCount: warnings.length,
    affectedReservationCount: input.totalReservations ?? 0,
    conflicts: input.conflicts,
  });
}
