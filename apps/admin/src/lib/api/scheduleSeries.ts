import { apiRequest } from "@/lib/api/client";

export type SeriesUiStatus = "ACTIVE" | "ENDING_SOON" | "ENDED";

export type SeriesListItem = {
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
    status: string;
    exception: "DETACHED" | "CANCELLED" | null;
  } | null;
  futureOccurrenceCount: number;
  futureBookingCount: number;
};

export type SeriesDetail = SeriesListItem & {
  capacity: number;
  upcomingOccurrences: Array<{
    id: string;
    startsAt: string;
    endsAt: string;
    status: string;
    exception: "DETACHED" | "CANCELLED" | null;
  }>;
  anchorOccurrenceId: string | null;
};

export type SeriesListFilter = {
  status?: "all" | "active" | "ended";
  search?: string;
  instructorId?: string;
};

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

export type FinishSeriesMode = "AFTER_LAST_SCHEDULED" | "ON_DATE";

export type FinishSeriesPreview = {
  boundaryDateKey: string;
  impact: MutationImpact;
  cancelledCount: number;
  bookedOccurrencesAffected: number;
  skippedDetachedCount: number;
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

export async function fetchScheduleSeriesList(
  studioId: string,
  filter: SeriesListFilter = {},
): Promise<SeriesListItem[]> {
  const params = new URLSearchParams();
  if (filter.status && filter.status !== "all") params.set("status", filter.status);
  if (filter.search?.trim()) params.set("search", filter.search.trim());
  if (filter.instructorId) params.set("instructorId", filter.instructorId);
  const qs = params.toString();
  return apiRequest<SeriesListItem[]>(
    `/studios/${studioId}/schedule-series${qs ? `?${qs}` : ""}`,
  );
}

export async function fetchScheduleSeriesDetail(
  studioId: string,
  seriesId: string,
): Promise<SeriesDetail> {
  return apiRequest<SeriesDetail>(`/studios/${studioId}/schedule-series/${seriesId}`);
}

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
    intervalWeeks?: number;
    endsOn?: string | null;
  },
): Promise<{
  impact: MutationImpact;
  recurrenceImpact?: SeriesRecurrenceImpact;
  conflicts: ScheduleConflict[];
}> {
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
    intervalWeeks?: number;
    endsOn?: string | null;
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

export async function previewFinishSeries(
  studioId: string,
  seriesId: string,
  input: {
    mode: FinishSeriesMode;
    boundaryDate?: string;
  },
): Promise<FinishSeriesPreview> {
  return apiRequest<FinishSeriesPreview>(
    `/studios/${studioId}/schedule-series/${seriesId}/finish-preview`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function finishSeries(
  studioId: string,
  seriesId: string,
  input: {
    mode: FinishSeriesMode;
    boundaryDate?: string;
    cancelReason?: string;
    confirmReservations?: boolean;
  },
): Promise<{ boundaryDateKey: string; cancelledCount: number }> {
  return apiRequest(`/studios/${studioId}/schedule-series/${seriesId}/finish`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
