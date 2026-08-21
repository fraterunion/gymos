import { apiRequest } from "@/lib/api/client";

export type ScheduleOperationConflict = {
  kind: string;
  severity: "BLOCKING" | "WARNING";
  message: string;
  scheduledClassId?: string;
};

export type ScheduleOperationResult = {
  proposedCount: number;
  createdCount: number;
  updatedCount: number;
  cancelledCount: number;
  skippedCount: number;
  skippedAlreadyExistsCount: number;
  warningCount: number;
  blockedCount: number;
  affectedReservationCount: number;
  conflicts: ScheduleOperationConflict[];
  affectedClassIds: string[];
  idempotentReplay?: boolean;
};

export type BulkOperation =
  | "CHANGE_INSTRUCTOR"
  | "CHANGE_CAPACITY"
  | "MOVE_TIME"
  | "CANCEL"
  | "DUPLICATE";

export async function previewDuplicateWeek(
  studioId: string,
  input: {
    sourceWeekStart: string;
    targetWeekStarts?: string[];
    repeatWeeks?: number;
  },
): Promise<ScheduleOperationResult> {
  return apiRequest(`/studios/${studioId}/schedule-operations/duplicate-week/preview`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function executeDuplicateWeek(
  studioId: string,
  input: {
    sourceWeekStart: string;
    targetWeekStarts?: string[];
    repeatWeeks?: number;
    confirmWarnings?: boolean;
    idempotencyKey?: string;
  },
): Promise<ScheduleOperationResult> {
  return apiRequest(`/studios/${studioId}/schedule-operations/duplicate-week`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function previewDuplicateClass(
  studioId: string,
  scheduledClassId: string,
  input: {
    localStart: { date: string; time: string };
    localEnd?: { date: string; time: string };
    capacity?: number;
    instructorId?: string | null;
  },
): Promise<ScheduleOperationResult> {
  return apiRequest(
    `/studios/${studioId}/schedule-operations/classes/${scheduledClassId}/duplicate/preview`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function executeDuplicateClass(
  studioId: string,
  scheduledClassId: string,
  input: {
    localStart: { date: string; time: string };
    localEnd?: { date: string; time: string };
    capacity?: number;
    instructorId?: string | null;
    confirmWarnings?: boolean;
    idempotencyKey?: string;
  },
): Promise<ScheduleOperationResult> {
  return apiRequest(
    `/studios/${studioId}/schedule-operations/classes/${scheduledClassId}/duplicate`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function previewBulkOperation(
  studioId: string,
  input: {
    scheduledClassIds: string[];
    operation: BulkOperation;
    instructorId?: string;
    capacity?: number;
    timeDeltaMinutes?: number;
    cancelReason?: string;
    weekOffsetWeeks?: number;
  },
): Promise<ScheduleOperationResult> {
  return apiRequest(`/studios/${studioId}/schedule-operations/bulk/preview`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function executeBulkOperation(
  studioId: string,
  input: {
    scheduledClassIds: string[];
    operation: BulkOperation;
    instructorId?: string;
    capacity?: number;
    timeDeltaMinutes?: number;
    cancelReason?: string;
    weekOffsetWeeks?: number;
    confirmWarnings?: boolean;
    confirmReservations?: boolean;
    idempotencyKey?: string;
  },
): Promise<ScheduleOperationResult> {
  return apiRequest(`/studios/${studioId}/schedule-operations/bulk`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
