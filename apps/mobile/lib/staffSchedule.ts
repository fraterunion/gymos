import {
  filterOperationalScheduleInWeek,
  studioWeekQueryRangeIso,
} from '@gymos/utils';
import { fetchStudioSchedule } from '@/lib/api/scheduleApi';
import type { ScheduledClassDto } from '@/lib/types/studio';

/** Staff schedule rows for a studio-local week (Monday–Sunday keys). */
export async function loadStaffScheduleWeek(
  studioId: string,
  timeZone: string,
  startKey: string,
  endKey: string,
): Promise<ScheduledClassDto[]> {
  const { from, to } = studioWeekQueryRangeIso(startKey, endKey, timeZone);
  const rows = await fetchStudioSchedule(studioId, from, to);
  return filterOperationalScheduleInWeek(rows, startKey, endKey, timeZone, studioId);
}
