import { localSlot } from './schedule-matching-dates-cancellation.service';

describe('matching future dates local slot', () => {
  it('uses the studio weekday and start time, not the UTC clock', () => {
    const thursdayMorning = localSlot(new Date('2026-11-12T13:15:00.000Z'), 'America/Mexico_City');
    expect(thursdayMorning).toEqual({ localDate: '2026-11-12', localTime: '07:15', weekday: 4 });

    const utcClock = localSlot(new Date('2026-11-12T07:15:00.000Z'), 'America/Mexico_City');
    expect(utcClock.localDate).toBe('2026-11-12');
    expect(utcClock.localTime).toBe('01:15');
    expect(utcClock.weekday).toBe(4);
  });
});
