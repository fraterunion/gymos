import { apiRequest } from '@/lib/api/client';

export type QrTokenResponse = {
  qrToken: string;
  expiresAt: string;
};

export type AttendanceSummaryDto = {
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

export type BookingAttendanceResponse = {
  attendance: AttendanceSummaryDto | null;
};

export type ClassRosterEntryDto = {
  /** Booking id */
  id: string;
  studioId: string;
  scheduledClassId: string;
  userId: string;
  status: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone?: string | null;
  };
};

/** Raw members check-in response — backend uses `method`; mapped to AttendanceSummaryDto. */
type StaffForceCheckInResponse = {
  success: boolean;
  attendance: {
    id: string;
    studioId: string;
    scheduledClassId: string;
    userId: string;
    method: string;
    checkedInAt: string;
    checkedInByUserId: string | null;
    user: AttendanceSummaryDto['user'];
  };
};

export async function fetchBookingAttendance(
  studioId: string,
  bookingId: string,
): Promise<BookingAttendanceResponse> {
  return apiRequest<BookingAttendanceResponse>(`/studios/${studioId}/bookings/${bookingId}/attendance`, {
    method: 'GET',
  });
}

export async function createBookingQr(studioId: string, bookingId: string): Promise<QrTokenResponse> {
  return apiRequest<QrTokenResponse>(`/studios/${studioId}/bookings/${bookingId}/qr`, {
    method: 'POST',
    body: '{}',
  });
}

/** Staff Mode: submit a scanned member QR token (STAFF | INSTRUCTOR | ADMIN | OWNER). */
export async function submitStaffQrScan(
  studioId: string,
  qrToken: string,
): Promise<AttendanceSummaryDto> {
  return apiRequest<AttendanceSummaryDto>(`/studios/${studioId}/check-ins/qr`, {
    method: 'POST',
    body: JSON.stringify({ qrToken }),
  });
}

/** Staff Mode: confirmed bookings for a scheduled class. */
export async function fetchClassRoster(
  studioId: string,
  classId: string,
): Promise<ClassRosterEntryDto[]> {
  return apiRequest<ClassRosterEntryDto[]>(
    `/studios/${studioId}/classes/${classId}/roster`,
    { method: 'GET' },
  );
}

/** Staff Mode: attendance records for a scheduled class. */
export async function fetchClassAttendance(
  studioId: string,
  classId: string,
): Promise<AttendanceSummaryDto[]> {
  return apiRequest<AttendanceSummaryDto[]>(
    `/studios/${studioId}/classes/${classId}/attendance`,
    { method: 'GET' },
  );
}

/** Staff Mode: manual check-in for a member booking (STAFF | ADMIN | OWNER). */
export async function staffForceCheckIn(
  studioId: string,
  userId: string,
  bookingId: string,
): Promise<AttendanceSummaryDto> {
  const res = await apiRequest<StaffForceCheckInResponse>(
    `/studios/${studioId}/members/${userId}/bookings/${bookingId}/check-in`,
    { method: 'POST', body: '{}' },
  );
  const a = res.attendance;
  return {
    id: a.id,
    studioId: a.studioId,
    scheduledClassId: a.scheduledClassId,
    userId: a.userId,
    checkInMethod: a.method,
    checkedInAt: a.checkedInAt,
    checkedInByUserId: a.checkedInByUserId,
    user: a.user,
  };
}

/** Register walk-in attendance without a reservation (OWNER | ADMIN | FRONT_DESK). */
export async function registerManualClassAttendance(
  studioId: string,
  classId: string,
  memberId: string,
): Promise<AttendanceSummaryDto> {
  return apiRequest<AttendanceSummaryDto>(
    `/studios/${studioId}/classes/${classId}/manual-attendance`,
    { method: 'POST', body: JSON.stringify({ memberId }) },
  );
}
