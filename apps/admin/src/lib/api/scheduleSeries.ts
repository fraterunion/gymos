import { apiRequest } from "@/lib/api/client";

export type SeriesMutationScope = "SINGLE" | "FOLLOWING" | "SERIES";

export type StudioLocalDateTime = {
  date: string;
  time: string;
};

export type ScheduleConflict = {
  kind: string;
  severity: "BLOCKING" | "WARNING";
  message: string;
};

export type SeriesPreviewResult = {
  classCount: number;
  breakdown: Record<string, { name: string; count: number }>;
  conflicts: ScheduleConflict[];
  blockingConflictCount: number;
  warningConflictCount: number;
};

export type MutationImpact = {
  affectedClassCount: number;
  classesWithReservations: number;
  totalReservations: number;
};

export type RecurringSeriesContext = {
  isRecurring: boolean;
  scheduleTemplateId?: string;
  label?: string;
  dayOfWeek?: number;
  startTime?: string;
  startsAt?: string;
  endsAt?: string | null;
  intervalWeeks?: number;
  active?: boolean;
};

export async function previewRecurringSeries(
  studioId: string,
  input: {
    classTemplateId: string;
    instructorId?: string | null;
    capacity?: number;
    daysOfWeek: number[];
    startTime: string;
    intervalWeeks?: number;
    startsOn: string;
    endsOn?: string | null;
  },
): Promise<SeriesPreviewResult> {
  return apiRequest<SeriesPreviewResult>(`/studios/${studioId}/schedule-series/preview`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createRecurringSeries(
  studioId: string,
  input: {
    classTemplateId: string;
    instructorId?: string | null;
    capacity?: number;
    daysOfWeek: number[];
    startTime: string;
    intervalWeeks?: number;
    startsOn: string;
    endsOn?: string | null;
    confirmWarnings?: boolean;
  },
): Promise<unknown> {
  return apiRequest<unknown>(`/studios/${studioId}/schedule-series`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchOccurrenceSeriesContext(
  studioId: string,
  scheduledClassId: string,
): Promise<RecurringSeriesContext> {
  return apiRequest<RecurringSeriesContext>(
    `/studios/${studioId}/schedule-series/occurrences/${scheduledClassId}/context`,
    { method: "GET" },
  );
}

export async function previewEditOccurrence(
  studioId: string,
  scheduledClassId: string,
  input: {
    scope: SeriesMutationScope;
    localStart?: StudioLocalDateTime;
    localEnd?: StudioLocalDateTime;
    capacity?: number;
    instructorId?: string | null;
  },
): Promise<{ impact: MutationImpact; conflicts: ScheduleConflict[] }> {
  return apiRequest(`/studios/${studioId}/schedule-series/occurrences/${scheduledClassId}/edit-preview`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function editSeriesOccurrence(
  studioId: string,
  scheduledClassId: string,
  input: {
    scope: SeriesMutationScope;
    localStart?: StudioLocalDateTime;
    localEnd?: StudioLocalDateTime;
    capacity?: number;
    instructorId?: string | null;
    confirmReservations?: boolean;
  },
): Promise<unknown> {
  return apiRequest(`/studios/${studioId}/schedule-series/occurrences/${scheduledClassId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function previewCancelOccurrence(
  studioId: string,
  scheduledClassId: string,
  scope: SeriesMutationScope,
): Promise<MutationImpact> {
  return apiRequest<MutationImpact>(
    `/studios/${studioId}/schedule-series/occurrences/${scheduledClassId}/cancel-preview`,
    {
      method: "POST",
      body: JSON.stringify({ scope }),
    },
  );
}

export async function cancelSeriesOccurrence(
  studioId: string,
  scheduledClassId: string,
  input: {
    scope: SeriesMutationScope;
    cancelReason?: string;
    confirmReservations?: boolean;
  },
): Promise<{ cancelledCount: number }> {
  return apiRequest(`/studios/${studioId}/schedule-series/occurrences/${scheduledClassId}`, {
    method: "DELETE",
    body: JSON.stringify(input),
  });
}
