import type { Href } from 'expo-router';

/** Canonical staff roster route used by Today, Schedule, and Dashboard. */
export function staffClassRosterHref(classId: string, className: string): Href {
  const params = new URLSearchParams({ classId, className });
  return `/(app)/staff-class-roster?${params.toString()}` as Href;
}

export const STAFF_CLASS_ROSTER_ROUTE = '/(app)/staff-class-roster' as const;
