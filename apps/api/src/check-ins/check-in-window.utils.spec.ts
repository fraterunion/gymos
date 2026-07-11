import {
  CHECK_IN_LATE_GRACE_MINUTES,
  getCheckInWindowBounds,
  isWithinCheckInWindow,
} from './check-in-window.utils';

describe('check-in-window.utils', () => {
  const startsAt = new Date('2030-06-15T18:00:00.000Z');
  const earlyOpenMinutes = 15;

  it('opens earlyOpenMinutes before class start and closes 30 minutes after', () => {
    const bounds = getCheckInWindowBounds(startsAt, earlyOpenMinutes);
    expect(bounds.opensAt.toISOString()).toBe('2030-06-15T17:45:00.000Z');
    expect(bounds.closesAt.toISOString()).toBe('2030-06-15T18:30:00.000Z');
  });

  it('accepts check-in at window open boundary', () => {
    const now = new Date('2030-06-15T17:45:00.000Z');
    expect(isWithinCheckInWindow(startsAt, now, earlyOpenMinutes)).toBe(true);
  });

  it('accepts check-in at window close boundary', () => {
    const now = new Date('2030-06-15T18:30:00.000Z');
    expect(isWithinCheckInWindow(startsAt, now, earlyOpenMinutes)).toBe(true);
  });

  it('rejects check-in before early window', () => {
    const now = new Date('2030-06-15T17:44:59.999Z');
    expect(isWithinCheckInWindow(startsAt, now, earlyOpenMinutes)).toBe(false);
  });

  it('rejects check-in after late window', () => {
    const now = new Date('2030-06-15T18:30:00.001Z');
    expect(isWithinCheckInWindow(startsAt, now, earlyOpenMinutes)).toBe(false);
  });

  it('uses configured late grace minutes', () => {
    const now = new Date('2030-06-15T18:45:00.000Z');
    expect(isWithinCheckInWindow(startsAt, now, earlyOpenMinutes, 45)).toBe(true);
    expect(
      isWithinCheckInWindow(startsAt, now, earlyOpenMinutes, CHECK_IN_LATE_GRACE_MINUTES),
    ).toBe(false);
  });
});
