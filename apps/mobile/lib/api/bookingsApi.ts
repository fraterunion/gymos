import { apiRequest } from '@/lib/api/client';
import type { BookingCancelResponse, BookingWithClass } from '@/lib/types/studio';

export async function fetchMyBookings(studioId: string): Promise<BookingWithClass[]> {
  return apiRequest<BookingWithClass[]>(`/studios/${studioId}/bookings/me`, { method: 'GET' });
}

export async function createClassBooking(studioId: string, classId: string): Promise<unknown> {
  return apiRequest<unknown>(`/studios/${studioId}/classes/${classId}/bookings`, {
    method: 'POST',
    body: '{}',
  });
}

export async function cancelBooking(studioId: string, bookingId: string): Promise<BookingCancelResponse> {
  return apiRequest<BookingCancelResponse>(`/studios/${studioId}/bookings/${bookingId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
