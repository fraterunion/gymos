import {
  fetchStudioSchedule,
  fetchTodayClasses,
  type TodayClassSummaryDto,
} from '@/lib/api/scheduleApi';
import { buildScheduleQueryRange, calendarDayKeyInZone, todayKeyInZone } from '@/lib/datetime';
import type { ScheduledClassDto } from '@/lib/types/studio';

/** Same studio-local day filter as admin web /check-in. */
export function filterStaffTodayScheduleRows(
  rows: ScheduledClassDto[],
  timeZone: string,
  at: Date = new Date(),
): ScheduledClassDto[] {
  const todayKey = todayKeyInZone(timeZone, at);
  return rows
    .filter(
      (row) =>
        row.status === 'SCHEDULED' && calendarDayKeyInZone(row.startsAt, timeZone) === todayKey,
    )
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

function mapScheduleRowToSummary(
  row: ScheduledClassDto,
  counts?: Pick<TodayClassSummaryDto, 'bookedCount' | 'checkedInCount'>,
): TodayClassSummaryDto {
  return {
    scheduledClassId: row.id,
    className: row.classTemplate.name,
    color: row.classTemplate.color,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    capacity: row.capacity,
    status: row.status,
    instructor: row.instructor
      ? { firstName: row.instructor.firstName, lastName: row.instructor.lastName }
      : null,
    bookedCount: counts?.bookedCount ?? row.bookedCount ?? 0,
    checkedInCount: counts?.checkedInCount ?? 0,
  };
}

/**
 * Staff/front-desk Today list — class selection matches admin /check-in;
 * booking/check-in counts come from today-summary when available.
 */
export async function loadStaffTodayClasses(
  studioId: string,
  timeZone: string,
  at: Date = new Date(),
): Promise<TodayClassSummaryDto[]> {
  const range = buildScheduleQueryRange();
  const [scheduleRows, summaryRows] = await Promise.all([
    fetchStudioSchedule(studioId, range.from, range.to),
    fetchTodayClasses(studioId).catch(() => [] as TodayClassSummaryDto[]),
  ]);

  const todayRows = filterStaffTodayScheduleRows(scheduleRows, timeZone, at);
  const summaryById = new Map(summaryRows.map((row) => [row.scheduledClassId, row]));

  return todayRows.map((row) => {
    const summary = summaryById.get(row.id);
    return mapScheduleRowToSummary(row, summary);
  });
}
