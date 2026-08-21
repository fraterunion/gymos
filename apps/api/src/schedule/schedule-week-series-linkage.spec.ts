import { ClassStatus, ScheduleOccurrenceExceptionKind } from '@prisma/client';
import { studioLocalTimeToUtc } from '../common/date/studio-local-date';
import { buildWeekReconciliationPlan } from './schedule-week-reconciliation';
import {
  applyDuplicateWeekSeriesLinkageToPlan,
  duplicateWeekCreateFields,
  enrichDuplicateWeekSlotsWithSeriesLinkage,
  resolveDuplicateWeekTargetLinkage,
} from './schedule-week-series-linkage';

const TZ_MX = 'America/Mexico_City';
const TZ_NY = 'America/New_York';
const NOW = new Date('2026-08-20T12:00:00.000Z');
const MONDAY = '2026-08-24';
const BIWEEKLY_ON = '2026-09-07';
const BIWEEKLY_OFF = '2026-08-31';

function weeklyTemplate(overrides = {}) {
  return {
    id: 'series-weekly',
    classTemplateId: 'class-1',
    dayOfWeek: 1,
    startTime: '06:00',
    intervalWeeks: 1,
    startsAt: null,
    endsAt: null,
    active: true,
    ...overrides,
  };
}

function biweeklyTemplate(overrides = {}) {
  return weeklyTemplate({
    id: 'series-biweekly',
    intervalWeeks: 2,
    startsAt: new Date('2026-08-18T12:00:00.000Z'),
    ...overrides,
  });
}

function slot(
  dateKey: string,
  time: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    classTemplateId: 'class-1',
    instructorId: 'inst-1',
    startsAt: studioLocalTimeToUtc(dateKey, time, TZ_MX),
    endsAt: studioLocalTimeToUtc(dateKey, '07:00', TZ_MX),
    capacity: 12,
    localDateKey: dateKey,
    targetWeekStart: '2026-08-24',
    ...overrides,
  };
}

describe('schedule-week-series-linkage', () => {
  describe('resolveDuplicateWeekTargetLinkage', () => {
    it('CASE 1: linked weekly source → valid target preserves scheduleTemplateId', () => {
      const s = slot(MONDAY, '06:00', { sourceScheduleTemplateId: 'series-weekly' });
      const result = resolveDuplicateWeekTargetLinkage(s, [weeklyTemplate()], TZ_MX);
      expect(result.desiredScheduleTemplateId).toBe('series-weekly');
      expect(result.detachedOffCadenceCopy).toBe(false);
    });

    it('CASE 2: linked biweekly source → valid cadence target preserves link', () => {
      const s = slot(BIWEEKLY_ON, '06:00', { sourceScheduleTemplateId: 'series-biweekly' });
      const result = resolveDuplicateWeekTargetLinkage(s, [biweeklyTemplate()], TZ_MX);
      expect(result.desiredScheduleTemplateId).toBe('series-biweekly');
      expect(result.detachedOffCadenceCopy).toBe(false);
    });

    it('CASE 2: linked biweekly source → off-cadence target does NOT fake linkage', () => {
      const s = slot(BIWEEKLY_OFF, '06:00', { sourceScheduleTemplateId: 'series-biweekly' });
      const result = resolveDuplicateWeekTargetLinkage(s, [biweeklyTemplate()], TZ_MX);
      expect(result.desiredScheduleTemplateId).toBeNull();
      expect(result.detachedOffCadenceCopy).toBe(true);
    });

    it('CASE 3: standalone source → standalone target', () => {
      const s = slot(MONDAY, '06:00', { sourceScheduleTemplateId: null });
      const result = resolveDuplicateWeekTargetLinkage(s, [weeklyTemplate()], TZ_MX);
      expect(result.desiredScheduleTemplateId).toBeNull();
      expect(result.reason).toBe('CASE_3_STANDALONE_SOURCE');
    });
  });

  describe('applyDuplicateWeekSeriesLinkageToPlan', () => {
    function existingRow(overrides = {}) {
      const startsAt = studioLocalTimeToUtc(MONDAY, '06:00', TZ_MX);
      return {
        id: 'row-1',
        classTemplateId: 'class-1',
        instructorId: 'inst-1',
        startsAt,
        endsAt: studioLocalTimeToUtc(MONDAY, '07:00', TZ_MX),
        capacity: 12,
        status: ClassStatus.SCHEDULED,
        scheduleTemplateId: null,
        exceptionKind: null,
        bookingCount: 0,
        attendanceCount: 0,
        waitlistCount: 0,
        classTemplateName: 'Pull',
        ...overrides,
      };
    }

    it('CASE 5: target standalone but matchable → link in-place', () => {
      const desired = enrichDuplicateWeekSlotsWithSeriesLinkage(
        [slot(MONDAY, '06:00', { sourceScheduleTemplateId: 'series-weekly' })],
        [weeklyTemplate()],
        TZ_MX,
      );
      const base = buildWeekReconciliationPlan(desired, [existingRow()], NOW);
      const plan = applyDuplicateWeekSeriesLinkageToPlan(base, [existingRow()]);
      const update = plan.actions.find((a) => a.kind === 'UPDATE');
      expect(update?.patch?.scheduleTemplateId).toBe('series-weekly');
    });

    it('CASE 4: target already linked correctly → REUSE', () => {
      const desired = enrichDuplicateWeekSlotsWithSeriesLinkage(
        [slot(MONDAY, '06:00', { sourceScheduleTemplateId: 'series-weekly' })],
        [weeklyTemplate()],
        TZ_MX,
      );
      const existing = existingRow({ scheduleTemplateId: 'series-weekly' });
      const base = buildWeekReconciliationPlan(desired, [existing], NOW);
      const plan = applyDuplicateWeekSeriesLinkageToPlan(base, [existing]);
      expect(plan.actions.some((a) => a.kind === 'REUSE')).toBe(true);
    });

    it('CASE 7: target linked to different template → BLOCK', () => {
      const desired = enrichDuplicateWeekSlotsWithSeriesLinkage(
        [slot(MONDAY, '06:00', { sourceScheduleTemplateId: 'series-weekly' })],
        [weeklyTemplate()],
        TZ_MX,
      );
      const existing = existingRow({ scheduleTemplateId: 'other-series' });
      const base = buildWeekReconciliationPlan(desired, [existing], NOW);
      const plan = applyDuplicateWeekSeriesLinkageToPlan(base, [existing]);
      expect(plan.actions.some((a) => a.kind === 'BLOCK')).toBe(true);
    });

    it('CASE 8: booking-bearing target preserves ID on in-place link', () => {
      const desired = enrichDuplicateWeekSlotsWithSeriesLinkage(
        [slot(MONDAY, '06:00', { sourceScheduleTemplateId: 'series-weekly' })],
        [weeklyTemplate()],
        TZ_MX,
      );
      const existing = existingRow({ bookingCount: 2 });
      const base = buildWeekReconciliationPlan(desired, [existing], NOW);
      const plan = applyDuplicateWeekSeriesLinkageToPlan(base, [existing]);
      const update = plan.actions.find((a) => a.kind === 'UPDATE');
      expect(update?.existingId).toBe('row-1');
      expect(update?.bookingCount).toBe(2);
    });
  });

  describe('duplicateWeekCreateFields', () => {
    it('off-cadence copy creates standalone DETACHED', () => {
      const fields = duplicateWeekCreateFields({
        ...slot(MONDAY, '06:00'),
        detachedOffCadenceCopy: true,
      });
      expect(fields.scheduleTemplateId).toBeNull();
      expect(fields.exceptionKind).toBe(ScheduleOccurrenceExceptionKind.DETACHED);
    });

    it('linked valid cadence create carries scheduleTemplateId', () => {
      const fields = duplicateWeekCreateFields({
        ...slot(MONDAY, '06:00'),
        desiredScheduleTemplateId: 'series-weekly',
      });
      expect(fields.scheduleTemplateId).toBe('series-weekly');
      expect(fields.exceptionKind).toBeNull();
    });
  });

  describe('timezone / DST', () => {
    it('New York DST slot resolves under weekly template', () => {
      const nyTemplate = weeklyTemplate({ dayOfWeek: 1, startTime: '06:00' });
      const s = {
        classTemplateId: 'class-1',
        startsAt: studioLocalTimeToUtc('2026-11-02', '06:00', TZ_NY),
        sourceScheduleTemplateId: 'series-weekly',
      };
      const result = resolveDuplicateWeekTargetLinkage(s, [nyTemplate], TZ_NY);
      expect(result.desiredScheduleTemplateId).toBe('series-weekly');
    });
  });
});
