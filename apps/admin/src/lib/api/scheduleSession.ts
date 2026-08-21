import { apiRequest } from "@/lib/api/client";

export type SessionRosterEntry = {
  userId: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  };
  bookingId: string | null;
  bookingCreatedAt: string | null;
  attendanceId: string | null;
  checkedInAt: string | null;
  checkInMethod: string | null;
  operationalStatus: "RESERVED" | "ATTENDED" | "WALK_IN";
  isWalkIn: boolean;
};

export type SessionWaitlistEntry = {
  id: string;
  userId: string;
  position: number;
  status: string;
  createdAt: string;
  user: SessionRosterEntry["user"];
};

export type SessionSeriesContext =
  | { isRecurring: false }
  | {
      isRecurring: true;
      scheduleTemplateId: string;
      label: string;
      dayOfWeek: number;
      startTime: string;
      startsAt: string | null;
      endsAt: string | null;
      intervalWeeks: number;
      active: boolean;
    };

export type SessionOperationalDto = {
  class: {
    id: string;
    studioId: string;
    classTemplateId: string;
    scheduleTemplateId: string | null;
    instructorId: string | null;
    startsAt: string;
    endsAt: string;
    capacity: number;
    status: string;
    cancelReason: string | null;
    exceptionKind: string | null;
    checkInWindowMinutes: number;
    classTemplate: {
      id: string;
      name: string;
      color: string | null;
      category: string | null;
    };
    instructor: {
      id: string;
      firstName: string;
      lastName: string;
    } | null;
  };
  occupancy: {
    capacity: number;
    booked: number;
    available: number;
    waitlist: number;
    attended: number;
  };
  roster: SessionRosterEntry[];
  waitlist: SessionWaitlistEntry[];
  seriesContext: SessionSeriesContext;
};

export async function fetchSessionOperational(
  studioId: string,
  scheduledClassId: string,
): Promise<SessionOperationalDto> {
  return apiRequest<SessionOperationalDto>(
    `/studios/${studioId}/schedule/${scheduledClassId}/session`,
    { method: "GET" },
  );
}
