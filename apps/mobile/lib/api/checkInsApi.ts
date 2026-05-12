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
