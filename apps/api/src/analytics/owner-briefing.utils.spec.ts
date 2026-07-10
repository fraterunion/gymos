import {
  dayWindows,
  monthComparisonWindows,
  pctChange,
  pickDelightSentence,
} from './owner-briefing.utils';

const TZ = 'UTC';

describe('owner-briefing.utils', () => {
  describe('monthComparisonWindows', () => {
    it('aligns same calendar day for July 10 in studio timezone', () => {
      const now = new Date('2026-07-10T14:00:00.000Z');
      const w = monthComparisonWindows(now, TZ);

      expect(w.monthStart.toISOString()).toBe('2026-07-01T00:00:00.000Z');
      expect(w.prevMonthStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
      expect(w.prevPeriodEnd.toISOString()).toBe('2026-06-11T00:00:00.000Z');
    });

    it('uses studio-local month boundaries for America/Mexico_City', () => {
      const now = new Date('2026-07-10T14:00:00.000Z');
      const w = monthComparisonWindows(now, 'America/Mexico_City');

      expect(w.monthStart.toISOString()).toBe('2026-07-01T06:00:00.000Z');
      expect(w.prevMonthStart.toISOString()).toBe('2026-06-01T06:00:00.000Z');
      expect(w.prevPeriodEnd.toISOString()).toBe('2026-06-11T06:00:00.000Z');
    });

    it('caps day-of-month on shorter previous months (March 31 vs February)', () => {
      const now = new Date('2026-03-31T12:00:00.000Z');
      const w = monthComparisonWindows(now, TZ);

      expect(w.prevMonthStart.toISOString()).toBe('2026-02-01T00:00:00.000Z');
      expect(w.prevPeriodEnd.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    });

    it('handles January rollover to December', () => {
      const now = new Date('2026-01-15T08:00:00.000Z');
      const w = monthComparisonWindows(now, TZ);

      expect(w.monthStart.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(w.prevMonthStart.toISOString()).toBe('2025-12-01T00:00:00.000Z');
      expect(w.prevPeriodEnd.toISOString()).toBe('2025-12-16T00:00:00.000Z');
    });
  });

  describe('dayWindows', () => {
    it('builds studio-local day boundaries in UTC', () => {
      const now = new Date('2026-07-10T14:00:00.000Z');
      const d = dayWindows(now, TZ);

      expect(d.todayStart.toISOString()).toBe('2026-07-10T00:00:00.000Z');
      expect(d.tomorrowStart.toISOString()).toBe('2026-07-11T00:00:00.000Z');
      expect(d.yesterdayStart.toISOString()).toBe('2026-07-09T00:00:00.000Z');
      expect(d.yesterdaySamePointEnd.toISOString()).toBe('2026-07-09T14:00:00.000Z');
    });

    it('builds studio-local day boundaries for America/Mexico_City', () => {
      const now = new Date('2026-07-10T14:00:00.000Z');
      const d = dayWindows(now, 'America/Mexico_City');

      expect(d.todayStart.toISOString()).toBe('2026-07-10T06:00:00.000Z');
      expect(d.tomorrowStart.toISOString()).toBe('2026-07-11T06:00:00.000Z');
      expect(d.yesterdayStart.toISOString()).toBe('2026-07-09T06:00:00.000Z');
    });
  });

  describe('pctChange', () => {
    it('returns null when prior is zero and current is positive', () => {
      expect(pctChange(100, 0)).toBeNull();
    });

    it('returns 0 when both are zero', () => {
      expect(pctChange(0, 0)).toBe(0);
    });

    it('rounds to one decimal place', () => {
      expect(pctChange(110, 100)).toBe(10);
      expect(pctChange(333, 300)).toBe(11);
    });
  });

  describe('pickDelightSentence', () => {
    it('returns null when both months have zero revenue', () => {
      expect(
        pickDelightSentence({
          monthComparisonPercent: null,
          attentionItemCount: 0,
          newMembershipsThisWeek: 0,
          monthCollectedCents: 0,
          prevMonthCollectedCents: 0,
        }),
      ).toBeNull();
    });

    it('returns Strong month when ahead by 10%+', () => {
      expect(
        pickDelightSentence({
          monthComparisonPercent: 12,
          attentionItemCount: 0,
          newMembershipsThisWeek: 0,
          monthCollectedCents: 112_000,
          prevMonthCollectedCents: 100_000,
        }),
      ).toBe('Strong month.');
    });

    it('returns Everything looks healthy when no attention and revenue is flat or up', () => {
      expect(
        pickDelightSentence({
          monthComparisonPercent: 0,
          attentionItemCount: 0,
          newMembershipsThisWeek: 1,
          monthCollectedCents: 100_000,
          prevMonthCollectedCents: 100_000,
        }),
      ).toBe('Everything looks healthy.');
    });

    it('returns null when attention items exist', () => {
      expect(
        pickDelightSentence({
          monthComparisonPercent: 3,
          attentionItemCount: 2,
          newMembershipsThisWeek: 1,
          monthCollectedCents: 103_000,
          prevMonthCollectedCents: 100_000,
        }),
      ).toBeNull();
    });
  });
});
