import { fetchStudioSchedule } from '@/lib/api/scheduleApi';
import { calendarDayKeyInZone } from '@/lib/datetime';
import type { ScheduledClassDto } from '@/lib/types/studio';

function dayRangeIso(dayKey: string): { from: string; to: string } {
  const from = new Date(`${dayKey}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${dayKey}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 2);
  to.setUTCHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Staff schedule rows for a studio-local week (Monday–Sunday keys). */
export async function loadStaffScheduleWeek(
  studioId: string,
  timeZone: string,
  startKey: string,
  endKey: string,
): Promise<ScheduledClassDto[]> {
  const { from } = dayRangeIso(startKey);
  const { to } = dayRangeIso(endKey);
  const rows = await fetchStudioSchedule(studioId, from, to);
  return rows
    .filter((row) => {
      const key = calendarDayKeyInZone(row.startsAt, timeZone);
      return key >= startKey && key <= endKey;
    })
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}
