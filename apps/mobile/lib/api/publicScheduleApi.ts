import { apiRequest } from '@/lib/api/client';
import type { ScheduledClassDto } from '@/lib/types/studio';

export async function fetchPublicSchedule(
  slug: string,
  from: string,
  to: string,
): Promise<ScheduledClassDto[]> {
  const q = new URLSearchParams({ from, to });
  return apiRequest<ScheduledClassDto[]>(`/public/studios/${slug}/schedule?${q.toString()}`, {
    method: 'GET',
    skipAuth: true,
  });
}
