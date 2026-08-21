import { ClassStatus, ScheduleOccurrenceExceptionKind } from '@prisma/client';
import {
  planFinishSeriesBoundary,
  planSeriesRecurrenceReconciliation,
} from './schedule-series-recurrence-reconcile';

describe('schedule-series-recurrence-reconcile', () => {
  const TZ = 'America/Mexico_City';
  const template = {
    id: 'tpl-1',
    classTemplateId: 'ct-1',
    instructorId: null,
    dayOfWeek: 4,
    startTime: '07:15',
    capacity: 12,
    startsAt: new Date('2026-08-20T06:00:00.000Z'),
    endsAt: null,
    intervalWeeks: 1,
    classTemplate: {
      id: 'ct-1',
      name: 'Booty Lab',
      durationMinutes: 60,
      defaultCapacity: 12,
    },
  };

  it('weekly → biweekly cancels off-cadence future rows', () => {
    const futureRows = [
      {
        id: 'a',
        startsAt: new Date('2026-08-27T13:15:00.000Z'),
        status: ClassStatus.SCHEDULED,
        exceptionKind: null,
        confirmedBookingCount: 0,
        attendanceCount: 0,
      },
      {
        id: 'b',
        startsAt: new Date('2026-09-03T13:15:00.000Z'),
        status: ClassStatus.SCHEDULED,
        exceptionKind: null,
        confirmedBookingCount: 0,
        attendanceCount: 0,
      },
    ];
    const plan = planSeriesRecurrenceReconciliation(
      template,
      { intervalWeeks: 2 },
      TZ,
      90,
      futureRows,
      new Date('2026-08-21T12:00:00.000Z'),
    );
    expect(plan.newIntervalWeeks).toBe(2);
    expect(plan.cancelledCount + plan.keptCount).toBeGreaterThan(0);
    expect(plan.toCancelIds.length + plan.toUpdateIds.length).toBeGreaterThan(0);
  });

  it('protects DETACHED and attendance-bearing rows from cancellation', () => {
    const futureRows = [
      {
        id: 'detached',
        startsAt: new Date('2026-09-03T13:15:00.000Z'),
        status: ClassStatus.SCHEDULED,
        exceptionKind: ScheduleOccurrenceExceptionKind.DETACHED,
        confirmedBookingCount: 0,
        attendanceCount: 0,
      },
      {
        id: 'attended',
        startsAt: new Date('2026-09-10T13:15:00.000Z'),
        status: ClassStatus.SCHEDULED,
        exceptionKind: null,
        confirmedBookingCount: 0,
        attendanceCount: 2,
      },
    ];
    const plan = planSeriesRecurrenceReconciliation(
      template,
      { intervalWeeks: 2 },
      TZ,
      90,
      futureRows,
      new Date('2026-08-21T12:00:00.000Z'),
    );
    expect(plan.skippedDetachedCount).toBe(1);
    expect(plan.skippedAttendanceCount).toBe(1);
    expect(plan.toCancelIds).not.toContain('detached');
    expect(plan.toCancelIds).not.toContain('attended');
  });

  it('bounded end cancels rows after inclusive boundary', () => {
    const futureRows = [
      {
        id: 'inside',
        startsAt: new Date('2026-09-24T13:15:00.000Z'),
        status: ClassStatus.SCHEDULED,
        exceptionKind: null,
        confirmedBookingCount: 0,
        attendanceCount: 0,
      },
      {
        id: 'outside',
        startsAt: new Date('2026-10-01T13:15:00.000Z'),
        status: ClassStatus.SCHEDULED,
        exceptionKind: null,
        confirmedBookingCount: 1,
        attendanceCount: 0,
      },
    ];
    const plan = planSeriesRecurrenceReconciliation(
      template,
      { endsOn: '2026-09-30' },
      TZ,
      90,
      futureRows,
      new Date('2026-08-21T12:00:00.000Z'),
    );
    expect(plan.toCancelIds).toContain('outside');
    expect(plan.bookedCancellationCount).toBe(1);
  });

  it('finish boundary cancels only rows after selected date', () => {
    const futureRows = [
      {
        id: 'keep',
        startsAt: new Date('2026-09-24T13:15:00.000Z'),
        status: ClassStatus.SCHEDULED,
        exceptionKind: null,
        confirmedBookingCount: 0,
        attendanceCount: 0,
      },
      {
        id: 'cancel',
        startsAt: new Date('2026-10-08T13:15:00.000Z'),
        status: ClassStatus.SCHEDULED,
        exceptionKind: null,
        confirmedBookingCount: 0,
        attendanceCount: 0,
      },
    ];
    const plan = planFinishSeriesBoundary(template, TZ, '2026-09-30', futureRows);
    expect(plan.cancelIds).toEqual(['cancel']);
  });
});
