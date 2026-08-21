import type { MemberAnalyticsPeriodKey } from './member-analytics-range.utils';
import type {
  ClassDemandBand,
  ClassScheduleOpportunityType,
  ClassScheduleHeatmapMetric,
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
    /** Confirmed bookings that attended / confirmed bookings (past eligible). */
    confirmedBookings: number;
    confirmedAttended: number;
    /** Secondary: Σ attendance / Σ capacity over eligible scheduled sessions. */
    capacityUtilizationPct: number | null;
    /** Secondary: same over active sessions only. */
    capacityUtilizationActivePct: number | null;
  };
};

export type ClassScheduleOpportunityDto = {
  type: ClassScheduleOpportunityType;
  title: string;
  reason: string;
  evidence: string;
  sampleSize: number;
  suggestedAction: string;
  classTemplateId: string | null;
  className: string | null;
  weekday: number | null;
  scheduleTime: string | null;
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
};

export type ClassScheduleActivityDto = {
  timezone: string;
  period: MemberAnalyticsPeriodKey;
  periodLabel: string;
  isPartialPeriod: boolean;
  analyticsDataAvailableFrom: string | null;
  opportunities: ClassScheduleOpportunityDto[];
  heatmap: ClassScheduleHeatmapCellDto[];
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
