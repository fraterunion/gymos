import type { MemberAnalyticsPeriodKey } from './member-analytics-range.utils';
import type {
  ClassDemandBand,
  ClassScheduleOpportunityType,
  ClassScheduleHeatmapMetric,
  OpportunitySignalKind,
  SlotMaturity,
  OperationalReading,
} from './class-schedule-engagement.utils';

export type ClassScheduleSummaryDto = {
  timezone: string;
  period: MemberAnalyticsPeriodKey;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  isPartialPeriod: boolean;
  analyticsDataAvailableFrom: string | null;
  /** Effective query start after applying trusted floor. */
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
  /** Transitional mirrors for older clients */
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
  period: MemberAnalyticsPeriodKey;
  periodLabel: string;
  isPartialPeriod: boolean;
  analyticsDataAvailableFrom: string | null;
  opportunities: ClassScheduleOpportunityDto[];
  operationalReadings: OperationalReading[];
  /** Primary strategic heatmap — ESTABLISHED_SLOT only. */
  heatmap: ClassScheduleHeatmapCellDto[];
  limitedHistorySlots: LimitedHistorySlotDto[];
  limitedHistorySummary: string | null;
  heatmapDefaultMetric: ClassScheduleHeatmapMetric;
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
