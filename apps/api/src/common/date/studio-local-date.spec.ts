import { getStudioLocalDateKey, studioLocalDateKeyToUtcAnchor } from './studio-local-date';

// ── getStudioLocalDateKey ────────────────────────────────────────────────────

describe('getStudioLocalDateKey', () => {
  it('returns correct local date for UTC noon in America/Mexico_City (UTC-6)', () => {
    // UTC 12:00 = 06:00 Mexico City → still June 8 local
    const date = new Date('2026-06-08T12:00:00.000Z');
    expect(getStudioLocalDateKey(date, 'America/Mexico_City')).toBe('2026-06-08');
  });

  it('maps a late-night UTC instant to the correct local date', () => {
    // UTC 04:30 on June 9 = 22:30 on June 8 in Mexico City (UTC-6)
    const date = new Date('2026-06-09T04:30:00.000Z');
    expect(getStudioLocalDateKey(date, 'America/Mexico_City')).toBe('2026-06-08');
  });

  it('maps UTC midnight to the previous local day for a UTC-behind timezone', () => {
    // UTC midnight June 8 = June 7 at 18:00 in Mexico City (UTC-6)
    const date = new Date('2026-06-08T00:00:00.000Z');
    expect(getStudioLocalDateKey(date, 'America/Mexico_City')).toBe('2026-06-07');
  });

  it('maps UTC midnight to the same local day for a UTC-ahead timezone', () => {
    // UTC midnight June 8 = June 8 at 05:00 in Asia/Karachi (UTC+5)
    const date = new Date('2026-06-08T00:00:00.000Z');
    expect(getStudioLocalDateKey(date, 'Asia/Karachi')).toBe('2026-06-08');
  });

  it('is independent of the host machine locale (uses en-CA formatting)', () => {
    const date = new Date('2026-06-08T12:00:00.000Z');
    // Both should produce the same result regardless of process.env.TZ
    expect(getStudioLocalDateKey(date, 'America/Mexico_City')).toBe('2026-06-08');
    expect(getStudioLocalDateKey(date, 'Asia/Karachi')).toBe('2026-06-08');
  });
});

// ── studioLocalDateKeyToUtcAnchor ────────────────────────────────────────────

describe('studioLocalDateKeyToUtcAnchor', () => {
  it('returns UTC midnight + 6 h for America/Mexico_City (UTC-6)', () => {
    const anchor = studioLocalDateKeyToUtcAnchor('2026-06-08', 'America/Mexico_City');
    // June 8 local midnight (UTC-6) = 2026-06-08T06:00:00Z
    expect(anchor.toISOString()).toBe('2026-06-08T06:00:00.000Z');
  });

  it('returns UTC midnight - 5 h for Asia/Karachi (UTC+5)', () => {
    const anchor = studioLocalDateKeyToUtcAnchor('2026-06-08', 'Asia/Karachi');
    // June 8 local midnight (UTC+5) = 2026-06-07T19:00:00Z
    expect(anchor.toISOString()).toBe('2026-06-07T19:00:00.000Z');
  });

  it('returns exact UTC midnight for UTC', () => {
    const anchor = studioLocalDateKeyToUtcAnchor('2026-06-08', 'UTC');
    expect(anchor.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });

  it('round-trips: getStudioLocalDateKey of the anchor returns the original key', () => {
    const dateKey = '2026-06-08';
    const anchor = studioLocalDateKeyToUtcAnchor(dateKey, 'America/Mexico_City');
    expect(getStudioLocalDateKey(anchor, 'America/Mexico_City')).toBe(dateKey);
  });

  it('round-trips for a UTC+ timezone', () => {
    const dateKey = '2026-06-08';
    const anchor = studioLocalDateKeyToUtcAnchor(dateKey, 'Asia/Karachi');
    expect(getStudioLocalDateKey(anchor, 'Asia/Karachi')).toBe(dateKey);
  });

  it('the anchor for a class at 6 am Mexico City resolves to the same validForDate', () => {
    // A class at 06:00 Mexico City local = 2026-06-08T12:00:00Z
    const classStartsAt = new Date('2026-06-08T12:00:00.000Z');
    const dateKey = getStudioLocalDateKey(classStartsAt, 'America/Mexico_City');
    const validForDate = studioLocalDateKeyToUtcAnchor(dateKey, 'America/Mexico_City');
    expect(validForDate.toISOString()).toBe('2026-06-08T06:00:00.000Z');
  });

  it('a late-night class (22:30 Mexico City) resolves to the correct date anchor', () => {
    // 22:30 Mexico City local = 2026-06-09T04:30:00Z
    const classStartsAt = new Date('2026-06-09T04:30:00.000Z');
    const dateKey = getStudioLocalDateKey(classStartsAt, 'America/Mexico_City');
    expect(dateKey).toBe('2026-06-08'); // still June 8 local
    const validForDate = studioLocalDateKeyToUtcAnchor(dateKey, 'America/Mexico_City');
    expect(validForDate.toISOString()).toBe('2026-06-08T06:00:00.000Z');
  });
});
