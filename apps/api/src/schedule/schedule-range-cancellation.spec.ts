import { calendarWeekCount, studioLocalRangeToUtc } from './schedule-range-cancellation.service';

describe('range cancellation date math', () => {
  it('maps inclusive studio-local dates to [local midnight, next local midnight) in UTC', () => {
    const { start, end } = studioLocalRangeToUtc('2026-11-02', '2026-11-22', 'America/Mexico_City');
    expect(start.toISOString()).toBe('2026-11-02T06:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-23T06:00:00.000Z');
    const east = studioLocalRangeToUtc('2026-11-02', '2026-11-02', 'Asia/Kolkata');
    expect(east.start.toISOString()).toBe('2026-11-01T18:30:00.000Z');
    expect(east.end.toISOString()).toBe('2026-11-02T18:30:00.000Z');
  });

  it('counts Monday-started calendar weeks touched by the range', () => {
    expect(calendarWeekCount('2026-11-02', '2026-11-08')).toBe(1); // Mon..Sun
    expect(calendarWeekCount('2026-11-08', '2026-11-09')).toBe(2); // Sun → Mon
    expect(calendarWeekCount('2026-11-02', '2026-11-22')).toBe(3);
    expect(calendarWeekCount('2026-12-28', '2027-01-10')).toBe(2); // across the year boundary
  });
});
