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
  reusedCount?: number;
  removedCount?: number;
  reviewCount?: number;
  warningCount: number;
  blockedCount: number;
  affectedReservationCount: number;
  conflicts: ScheduleOperationConflict[];
  affectedClassIds: string[];
  idempotentReplay?: boolean;
  reconciliationItems?: ScheduleReconciliationItem[];
};

export type ScheduleReconciliationItem = {
  kind: "CREATE" | "REUSE" | "UPDATE" | "REMOVE" | "REVIEW" | "BLOCK";
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
    confirmRemovals?: boolean;
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

export type RangeCancelClass = {
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

export type RangeCancelProtectedClass = RangeCancelClass & { reason: "STARTED" | "ATTENDED"; attendances: number };

export type RangeCancelFilters = {
  fromDate: string;
  toDate: string;
  instructorIds?: string[];
  classTemplateIds?: string[];
};

export type RangeCancelPreview = {
  timezone: string;
  fromDate: string;
  toDate: string;
  weekCount: number;
  classes: RangeCancelClass[];
  protectedClasses: RangeCancelProtectedClass[];
  alreadyCancelledCount: number;
  totals: { classes: number; bookings: number; waitlist: number; protected: number };
  previewFingerprint: string;
};

export type RangeCancelResult = {
  cancelledCount: number;
  cancelledBookingCount: number;
  expiredWaitlistCount: number;
  cancelledClassIds: string[];
  protectedClasses: RangeCancelProtectedClass[];
  idempotentReplay?: boolean;
};

export async function previewRangeCancel(studioId: string, body: RangeCancelFilters): Promise<RangeCancelPreview> {
  return apiRequest(`/studios/${studioId}/schedule-operations/range-cancel/preview`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function executeRangeCancel(
  studioId: string,
  body: RangeCancelFilters & { previewFingerprint: string; cancelReason?: string; idempotencyKey: string },
): Promise<RangeCancelResult> {
  return apiRequest(`/studios/${studioId}/schedule-operations/range-cancel`, {
    method: "POST",
    body: JSON.stringify({ ...body, confirm: true }),
  });
}
