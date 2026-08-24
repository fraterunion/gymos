import { hasOperationalHistory } from './schedule-occurrence-history';

describe('hasOperationalHistory', () => {
  it('is empty when all counts are zero', () => {
    expect(
      hasOperationalHistory({ bookingCount: 0, attendanceCount: 0, waitlistCount: 0 }),
    ).toBe(false);
  });

  it('is unsafe with confirmed bookings', () => {
    expect(
      hasOperationalHistory({ bookingCount: 1, attendanceCount: 0, waitlistCount: 0 }),
    ).toBe(true);
  });

  it('is unsafe with attendance', () => {
    expect(
      hasOperationalHistory({ bookingCount: 0, attendanceCount: 2, waitlistCount: 0 }),
    ).toBe(true);
  });

  it('is unsafe with waiting waitlist', () => {
    expect(
      hasOperationalHistory({ bookingCount: 0, attendanceCount: 0, waitlistCount: 1 }),
    ).toBe(true);
  });
});
