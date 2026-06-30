import {
  ARES_WEEKLY_SCHEDULE,
  expectedClassesPerWeek,
  totalWeeklyTemplateSlots,
} from './ares-1.3-schedule-pattern';

describe('ARES 1.3 weekly schedule pattern', () => {
  it('defines 36 weekly template slots', () => {
    expect(totalWeeklyTemplateSlots()).toBe(36);
  });

  it('matches expected per-day class counts', () => {
    expect(expectedClassesPerWeek()).toEqual({
      Mon: 7,
      Tue: 7,
      Wed: 7,
      Thu: 7,
      Fri: 5,
      Sat: 2,
      Sun: 1,
    });
  });

  it('assigns Saturday slots to Street Bars and Upperbody', () => {
    const sat = ARES_WEEKLY_SCHEDULE.filter((d) => d.dayOfWeek === 6);
    expect(sat).toHaveLength(2);
    expect(sat.map((d) => d.classTemplateName).sort()).toEqual(['Street Bars', 'Upperbody']);
    expect(sat.find((d) => d.classTemplateName === 'Street Bars')?.startTimes).toEqual(['08:00']);
    expect(sat.find((d) => d.classTemplateName === 'Upperbody')?.startTimes).toEqual(['09:00']);
  });

  it('does not include ad-hoc-only templates in the weekly pattern', () => {
    const names = new Set(ARES_WEEKLY_SCHEDULE.map((d) => d.classTemplateName));
    expect(names.has('Calirox')).toBe(false);
    expect(names.has('Hyrox')).toBe(false);
  });
});
