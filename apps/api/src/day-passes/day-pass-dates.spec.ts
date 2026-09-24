import {
  DAY_PASS_PURCHASE_HORIZON_DAYS,
  classifyDayPassDate,
  dayPassDateWindow,
  resolveRequestedDayPassDate,
} from './day-pass-dates';

/**
 * The studio clock is the only clock. These fixtures sit around Mexico City midnight
 * (UTC-6, no DST since 2023) so the UTC calendar day and the studio day disagree.
 */
const MX = 'America/Mexico_City';
/** 23:30 on Sept 23 in Mexico City == 05:30Z on Sept 24. */
const LATE_NIGHT_MX = new Date('2026-09-24T05:30:00.000Z');
/** 00:10 on Sept 24 in Mexico City == 06:10Z on Sept 24. */
const JUST_AFTER_MIDNIGHT_MX = new Date('2026-09-24T06:10:00.000Z');

describe('dayPassDateWindow', () => {
  it('derives today and the horizon from the studio timezone, not UTC', () => {
    const w = dayPassDateWindow(MX, LATE_NIGHT_MX);
    expect(w).toEqual({ timezone: MX, todayKey: '2026-09-23', maxDateKey: '2026-10-23', horizonDays: DAY_PASS_PURCHASE_HORIZON_DAYS });
    expect(dayPassDateWindow(MX, JUST_AFTER_MIDNIGHT_MX).todayKey).toBe('2026-09-24');
    expect(dayPassDateWindow('UTC', LATE_NIGHT_MX).todayKey).toBe('2026-09-24');
  });
});

describe('resolveRequestedDayPassDate', () => {
  it('omitted (legacy client) → studio-local today', () => {
    const r = resolveRequestedDayPassDate(undefined, MX, LATE_NIGHT_MX);
    expect(r.ok && r.key).toBe('2026-09-23');
    expect(r.ok && r.anchorUtc.toISOString()).toBe('2026-09-23T06:00:00.000Z');
    expect(resolveRequestedDayPassDate('', MX, LATE_NIGHT_MX).ok && true).toBe(true);
  });

  it('today, tomorrow and today+30 are accepted; today+31 is beyond the horizon', () => {
    expect(resolveRequestedDayPassDate('2026-09-23', MX, LATE_NIGHT_MX)).toMatchObject({ ok: true, key: '2026-09-23' });
    expect(resolveRequestedDayPassDate('2026-09-24', MX, LATE_NIGHT_MX)).toMatchObject({ ok: true, key: '2026-09-24' });
    expect(resolveRequestedDayPassDate('2026-10-23', MX, LATE_NIGHT_MX)).toMatchObject({ ok: true, key: '2026-10-23' });
    expect(resolveRequestedDayPassDate('2026-10-24', MX, LATE_NIGHT_MX)).toMatchObject({ ok: false, reason: 'beyond_horizon' });
  });

  it('a past studio-local day is rejected even when it is still "today" in UTC', () => {
    // 00:10 Sept 24 in Mexico City: Sept 23 is over there, although a UTC-based device says Sept 24 anyway;
    // an Asia/Tokyo device at the same instant is on Sept 24 15:10 and might "see" Sept 25 as tomorrow.
    expect(resolveRequestedDayPassDate('2026-09-23', MX, JUST_AFTER_MIDNIGHT_MX)).toMatchObject({ ok: false, reason: 'past' });
    // 23:30 Sept 23 in Mexico City: a UTC device already shows Sept 24 — that is a valid FUTURE day here, not "today".
    expect(resolveRequestedDayPassDate('2026-09-24', MX, LATE_NIGHT_MX)).toMatchObject({ ok: true, key: '2026-09-24' });
  });

  it('non-calendar or non-canonical keys are rejected, never silently normalised', () => {
    for (const bad of ['2026-13-01', '2026-02-30', '2026-9-3', '26-09-23', 'tomorrow', '2026-09-23T00:00:00Z']) {
      expect(resolveRequestedDayPassDate(bad, MX, LATE_NIGHT_MX)).toMatchObject({ ok: false, reason: 'invalid' });
    }
  });

  it('the anchor is the UTC instant of studio-local midnight for the chosen day', () => {
    const r = resolveRequestedDayPassDate('2026-09-30', MX, LATE_NIGHT_MX);
    expect(r.ok && r.anchorUtc.toISOString()).toBe('2026-09-30T06:00:00.000Z');
    const ny = resolveRequestedDayPassDate('2026-09-30', 'America/New_York', LATE_NIGHT_MX);
    expect(ny.ok && ny.anchorUtc.toISOString()).toBe('2026-09-30T04:00:00.000Z');
  });
});

describe('classifyDayPassDate', () => {
  it('classifies relative to studio-local today', () => {
    expect(classifyDayPassDate('2026-09-23', '2026-09-23')).toBe('today');
    expect(classifyDayPassDate('2026-09-25', '2026-09-23')).toBe('upcoming');
    expect(classifyDayPassDate('2026-09-22', '2026-09-23')).toBe('past');
  });
});
