import { apiRequest } from '@/lib/api/client';
import type { ScheduledClassDto } from '@/lib/types/studio';

export type TodayClassSummaryDto = {
  scheduledClassId: string;
  className: string;
  color: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number;
  status: string;
  instructor: {
    firstName: string;
    lastName: string;
  } | null;
  bookedCount: number;
  checkedInCount: number;
};

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

/** Staff Mode: today's classes with booking and check-in counts (studio-local day). */
export async function fetchTodayClasses(studioId: string): Promise<TodayClassSummaryDto[]> {
  return apiRequest<TodayClassSummaryDto[]>(`/studios/${studioId}/schedule/today-summary`, {
    method: 'GET',
  });
}
