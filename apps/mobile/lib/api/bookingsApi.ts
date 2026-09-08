import { apiRequest } from '@/lib/api/client';
import type { BookingCancelResponse, BookingWithClass } from '@/lib/types/studio';

export async function fetchMyBookings(studioId: string): Promise<BookingWithClass[]> {
  return apiRequest<BookingWithClass[]>(`/studios/${studioId}/bookings/me`, { method: 'GET' });
}

/** MM-5: the API echoes which membership the booking is charged to (null for Day Pass /
 *  staff bypass) so the confirmation can say when a scarce credit was consumed. */
export type BookingCreatedResponse = {
  id: string;
  chargedMembership: {
    subscriptionId: string;
    planName: string;
    creditConsumed: boolean;
  } | null;
};

export async function createClassBooking(
  studioId: string,
  classId: string,
): Promise<BookingCreatedResponse> {
  return apiRequest<BookingCreatedResponse>(`/studios/${studioId}/classes/${classId}/bookings`, {
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
