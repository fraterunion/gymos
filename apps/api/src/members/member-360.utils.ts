import type { BookingStatus } from '@prisma/client';

export function buildMemberEngagement(input: {
  visitsCurrentPeriod: number;
  visitsLast30Days: number;
  daysSinceLastVisit: number | null;
}) {
  return {
    ...input,
    averageVisitsPerWeekLast30: Math.round((input.visitsLast30Days / (30 / 7)) * 10) / 10,
  };
}

export function buildBookingSummary(
  grouped: Array<{ status: BookingStatus; _count: { _all: number } }>,
  upcoming: number,
) {
  const count = (status: BookingStatus) => grouped.find((row) => row.status === status)?._count._all ?? 0;
  return {
    upcoming,
    completed: count('COMPLETED'),
    cancelled: count('CANCELLED'),
    noShows: count('NO_SHOW'),
  };
}

export function buildAttendanceRate(attended: number, noShows: number) {
  const completedOutcomes = attended + noShows;
  return completedOutcomes > 0 ? Math.round((attended / completedOutcomes) * 100) : null;
}

export function isCurrentImmutableCycle(cycle: { startsAt: Date; endsAt: Date }, now: Date) {
  return cycle.startsAt <= now && cycle.endsAt > now;
}

export function sortMemberTimeline<T extends { occurredAt: Date }>(events: T[]): T[] {
  return [...events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
}
