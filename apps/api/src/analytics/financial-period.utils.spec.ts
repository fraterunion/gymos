import { financialPeriodWindows } from './financial-period.utils';

const TZ = 'UTC';

describe('financialPeriodWindows', () => {
  it('aligns today vs yesterday to the same elapsed time', () => {
    const now = new Date('2026-07-10T14:00:00.000Z');
    const w = financialPeriodWindows(now, TZ, 'today');

    expect(w.periodStart.toISOString()).toBe('2026-07-10T00:00:00.000Z');
    expect(w.periodEnd).toEqual(now);
    expect(w.prevPeriodStart.toISOString()).toBe('2026-07-09T00:00:00.000Z');
    expect(w.prevPeriodEnd.toISOString()).toBe('2026-07-09T14:00:00.000Z');
  });

  it('uses Monday as week start in studio-local calendar', () => {
    const now = new Date('2026-07-10T14:00:00.000Z'); // Friday
    const w = financialPeriodWindows(now, TZ, 'week');

    expect(w.periodStart.toISOString()).toBe('2026-07-06T00:00:00.000Z');
    expect(w.prevPeriodStart.toISOString()).toBe('2026-06-29T00:00:00.000Z');
    expect(w.prevPeriodEnd.toISOString()).toBe('2026-07-03T14:00:00.000Z');
  });

  it('aligns month to same point last month', () => {
    const now = new Date('2026-07-10T14:00:00.000Z');
    const w = financialPeriodWindows(now, TZ, 'month');

    expect(w.periodStart.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(w.prevPeriodStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(w.prevPeriodEnd.toISOString()).toBe('2026-06-11T00:00:00.000Z');
  });

  it('aligns year to same elapsed point last year', () => {
    const now = new Date('2026-07-10T14:00:00.000Z');
    const w = financialPeriodWindows(now, TZ, 'year');

    expect(w.periodStart.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(w.prevPeriodStart.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(w.prevPeriodEnd.toISOString()).toBe('2025-07-10T14:00:00.000Z');
  });
});
