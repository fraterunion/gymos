import { apiRequest } from '@/lib/api/client';
import type { ScheduledClassDto } from '@/lib/types/studio';

export async function fetchStudioSchedule(
  studioId: string,
  from: string,
  to: string,
): Promise<ScheduledClassDto[]> {
  const q = new URLSearchParams({ from, to });
  return apiRequest<ScheduledClassDto[]>(`/studios/${studioId}/schedule?${q.toString()}`, {
    method: 'GET',
  });
}
