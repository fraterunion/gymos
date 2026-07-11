import { classRosterHref, scheduleHref } from '@/lib/classRosterNav';

/** Type-checked navigation helpers for any-date roster deep links. */
export function assertClassRosterNavTypes(): void {
  const roster = classRosterHref('cls_123', {
    returnTo: 'schedule',
    weekStart: '2030-06-02T00:00:00.000Z',
  });
  const schedule = scheduleHref('2030-06-02T00:00:00.000Z');
  void roster;
  void schedule;
}

assertClassRosterNavTypes();
