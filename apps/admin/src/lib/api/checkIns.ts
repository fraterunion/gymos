import { apiRequest } from "@/lib/api/client";

export type AttendanceSummary = {
  id: string;
  studioId: string;
  scheduledClassId: string;
  userId: string;
  checkInMethod: string;
  checkedInAt: string;
  checkedInByUserId: string | null;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  };
};

export async function fetchClassAttendance(
  studioId: string,
  classId: string,
): Promise<AttendanceSummary[]> {
  return apiRequest<AttendanceSummary[]>(`/studios/${studioId}/classes/${classId}/attendance`, {
    method: "GET",
  });
}

export async function checkInWithQr(studioId: string, qrToken: string): Promise<AttendanceSummary> {
  return apiRequest<AttendanceSummary>(`/studios/${studioId}/check-ins/qr`, {
    method: "POST",
    body: JSON.stringify({ qrToken: qrToken.trim() }),
  });
}

export async function checkInManual(studioId: string, bookingId: string): Promise<AttendanceSummary> {
  return apiRequest<AttendanceSummary>(`/studios/${studioId}/check-ins/manual`, {
    method: "POST",
    body: JSON.stringify({ bookingId }),
  });
}

export async function registerManualClassAttendance(
  studioId: string,
  classId: string,
  memberId: string,
): Promise<AttendanceSummary> {
  return apiRequest<AttendanceSummary>(`/studios/${studioId}/classes/${classId}/manual-attendance`, {
    method: "POST",
    body: JSON.stringify({ memberId }),
  });
}
