import { apiRequest } from "@/lib/api/client";

export type ClassDemandBand = "ALTA" | "FUERTE" | "NORMAL" | "BAJA" | "INSUFICIENTE";
export type SlotMaturity = "ESTABLISHED_SLOT" | "LIMITED_HISTORY_SLOT";
export type OpportunitySignalKind = "FORTALEZA" | "REVISAR" | "COMPARACION" | "ALERTA";

export type ClassScheduleOpportunityType =
  | "STRONG_SLOT"
  | "REVIEW_LOW_DEMAND"
  | "COMPARE_CLASS_TIME"
  | "HIGH_MISS_RATE";

export type ClassScheduleSummaryDto = {
  timezone: string;
  period: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  isPartialPeriod: boolean;
  analyticsDataAvailableFrom: string | null;
  effectivePeriodStart: string;
  trustedFloorApplied: boolean;
  instructorAttributionSufficient: boolean;
  waitlistAnalyticsAvailable: boolean;
  kpis: {
    activeSessions: number;
    scheduledSessions: number;
    emptySessions: number;
    emptySessionRatePct: number | null;
    attendances: number;
    avgAttendancePerActiveSession: number | null;
    showRatePct: number | null;
    confirmedBookings: number;
    confirmedAttended: number;
    capacityUtilizationPct: number | null;
    capacityUtilizationActivePct: number | null;
  };
};

export type ClassScheduleOpportunityDto = {
  type: ClassScheduleOpportunityType;
  signalKind: OpportunitySignalKind;
  title: string;
  subject: string;
  headlineMetric: string;
  supportingMetric: string;
  suggestedAction: string;
  sampleSize: number;
  classTemplateId: string | null;
  className: string | null;
  weekday: number | null;
  scheduleTime: string | null;
  reason: string;
  evidence: string;
};

export type ClassScheduleHeatmapCellDto = {
  weekday: number;
  hour: number;
  scheduleTime: string;
  sessions: number;
  activeSessions: number;
  emptySessions: number;
  avgAttendance: number | null;
  avgBookings: number | null;
  attendanceOccupancyPct: number | null;
  bookingOccupancyPct: number | null;
  totalAttendances: number;
  slotMaturity: SlotMaturity;
  distinctWeeks: number;
};

export type LimitedHistorySlotDto = {
  weekday: number;
  scheduleTime: string;
  scheduledSessions: number;
  distinctWeeks: number;
  classNames: string[];
  totalAttendances: number;
};

export type OperationalReadingDto = {
  text: string;
  evidence: string;
  sampleSize: number;
  kind?: string;
  className?: string | null;
  weekday?: number | null;
  scheduleTime?: string | null;
};

export type ClassTemplateRowDto = {
  classTemplateId: string;
  className: string;
  scheduledSessions: number;
  activeSessions: number;
  emptySessions: number;
  emptyRatePct: number | null;
  attendances: number;
  uniqueMembers: number;
  avgAttendancePerActiveSession: number | null;
  avgBookingsPerActiveSession: number | null;
  showRatePct: number | null;
  attendanceOccupancyPct: number | null;
  bookingOccupancyPct: number | null;
  sampleInsufficient: boolean;
  capacityTypical: number | null;
};

export type ClassScheduleSlotRowDto = {
  weekday: number;
  scheduleTime: string;
  scheduledSessions: number;
  activeSessions: number;
  emptySessions: number;
  emptyRatePct: number | null;
  avgAttendance: number | null;
  avgBookings: number | null;
  showRatePct: number | null;
  attendanceOccupancyPct: number | null;
  bookingOccupancyPct: number | null;
  band: ClassDemandBand;
  sampleInsufficient: boolean;
  totalAttendances: number;
  slotMaturity: SlotMaturity;
  distinctWeeks: number;
};

export type ClassScheduleActivityDto = {
  timezone: string;
  period: string;
  periodLabel: string;
  isPartialPeriod: boolean;
  analyticsDataAvailableFrom: string | null;
  opportunities: ClassScheduleOpportunityDto[];
  operationalReadings: OperationalReadingDto[];
  heatmap: ClassScheduleHeatmapCellDto[];
  limitedHistorySlots: LimitedHistorySlotDto[];
  limitedHistorySummary: string | null;
  heatmapDefaultMetric: string;
  instructorNote: string | null;
  waitlistNote: string | null;
};

export type ClassTemplateDetailDto = ClassTemplateRowDto & {
  bySlot: Array<{
    weekday: number;
    scheduleTime: string;
    sessions: number;
    activeSessions: number;
    avgAttendance: number | null;
    avgBookings: number | null;
    sampleInsufficient: boolean;
    slotMaturity: SlotMaturity;
  }>;
  recentSessions: Array<{
    scheduledClassId: string;
    startsAt: string;
    weekday: number;
    scheduleTime: string;
    capacity: number;
    bookings: number;
    attendances: number;
    isActive: boolean;
    isEmpty: boolean;
    confirmedAttended: number;
    missedReservations: number;
  }>;
  insight: string | null;
  insightEvidence: string | null;
};

function qs(params: Record<string, string | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function fetchClassScheduleSummary(studioId: string, period: string) {
  return apiRequest<ClassScheduleSummaryDto>(
    `/studios/${studioId}/analytics/classes/summary${qs({ period })}`,
  );
}

export function fetchClassScheduleActivity(studioId: string, period: string) {
  return apiRequest<ClassScheduleActivityDto>(
    `/studios/${studioId}/analytics/classes/activity${qs({ period })}`,
  );
}

export function fetchClassScheduleTemplates(studioId: string, period: string) {
  return apiRequest<{ data: ClassTemplateRowDto[] }>(
    `/studios/${studioId}/analytics/classes/templates${qs({ period })}`,
  );
}

export function fetchClassScheduleSlots(studioId: string, period: string) {
  return apiRequest<{ data: ClassScheduleSlotRowDto[] }>(
    `/studios/${studioId}/analytics/classes/slots${qs({ period })}`,
  );
}

export function fetchClassScheduleTemplateDetail(
  studioId: string,
  classTemplateId: string,
  period: string,
) {
  return apiRequest<ClassTemplateDetailDto>(
    `/studios/${studioId}/analytics/classes/templates/${classTemplateId}${qs({ period })}`,
  );
}
