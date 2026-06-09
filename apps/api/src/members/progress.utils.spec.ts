import {
  computeIsoWeekStreaks,
  getCurrentStudioMonthBounds,
  getIsoWeekKey,
  previousIsoWeekKey,
} from './progress.utils';

describe('getCurrentStudioMonthBounds', () => {
  it('returns June bounds for America/Mexico_City', () => {
    const now = new Date('2026-06-15T18:00:00Z');
    const bounds = getCurrentStudioMonthBounds('America/Mexico_City', now);
    expect(bounds.year).toBe(2026);
    expect(bounds.month).toBe(6);
    expect(bounds.start.toISOString()).toBe('2026-06-01T06:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-07-01T06:00:00.000Z');
  });
});

describe('getIsoWeekKey', () => {
  it('maps a class instant to the studio-local ISO week', () => {
    const key = getIsoWeekKey(
      new Date('2026-06-08T15:00:00Z'),
      'America/Mexico_City',
    );
    expect(key).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe('computeIsoWeekStreaks', () => {
  it('returns zero streaks when no weeks attended', () => {
    expect(
      computeIsoWeekStreaks(new Set(), '2026-W24'),
    ).toEqual({ currentStreak: 0, bestStreak: 0 });
  });

  it('counts consecutive ISO weeks for current and best streaks', () => {
    const w1 = '2026-W20';
    const w2 = '2026-W21';
    const w3 = '2026-W22';
    const w5 = '2026-W24';
    expect(previousIsoWeekKey(w5)).toBe('2026-W23');

    const streaks = computeIsoWeekStreaks(
      new Set([w1, w2, w3, w5]),
      w5,
    );
    expect(streaks.currentStreak).toBe(1);
    expect(streaks.bestStreak).toBe(3);
  });

  it('extends current streak across consecutive weeks including current week', () => {
    const w22 = '2026-W22';
    const w23 = '2026-W23';
    const w24 = '2026-W24';
    const streaks = computeIsoWeekStreaks(
      new Set([w22, w23, w24]),
      w24,
    );
    expect(streaks.currentStreak).toBe(3);
    expect(streaks.bestStreak).toBe(3);
  });
});
