import { apiRequest } from '@/lib/api/client';
import type { MyWaitlistEntry, WaitlistJoinResponse } from '@/lib/types/studio';

export async function fetchMyWaitlist(studioId: string): Promise<MyWaitlistEntry[]> {
  return apiRequest<MyWaitlistEntry[]>(`/studios/${studioId}/waitlist/me`, { method: 'GET' });
}

export async function joinClassWaitlist(studioId: string, classId: string): Promise<WaitlistJoinResponse> {
  return apiRequest<WaitlistJoinResponse>(`/studios/${studioId}/classes/${classId}/waitlist`, {
    method: 'POST',
    body: '{}',
  });
}

export async function cancelWaitlistEntry(studioId: string, entryId: string): Promise<void> {
  await apiRequest<void>(`/studios/${studioId}/waitlist/${entryId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
