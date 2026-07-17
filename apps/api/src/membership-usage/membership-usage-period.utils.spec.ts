import { resolveBillingPeriodForClassDate } from './membership-usage-period.utils';

describe('resolveBillingPeriodForClassDate', () => {
  const currentStart = new Date('2025-08-01T00:00:00.000Z');
  const currentEnd = new Date('2025-09-01T00:00:00.000Z');

  it('returns current period when class is inside it', () => {
    const classStartsAt = new Date('2025-08-15T12:00:00.000Z');
    expect(
      resolveBillingPeriodForClassDate(
        { currentPeriodStart: currentStart, currentPeriodEnd: currentEnd },
        classStartsAt,
      ),
    ).toEqual({ start: currentStart, end: currentEnd });
  });

  it('walks back one period for a historical July class', () => {
    const classStartsAt = new Date('2025-07-20T12:00:00.000Z');
    const period = resolveBillingPeriodForClassDate(
      { currentPeriodStart: currentStart, currentPeriodEnd: currentEnd },
      classStartsAt,
    );
    expect(period).toEqual({
      start: new Date('2025-07-01T00:00:00.000Z'),
      end: currentStart,
    });
  });

  it('returns null when period bounds are missing', () => {
    expect(
      resolveBillingPeriodForClassDate(
        { currentPeriodStart: null, currentPeriodEnd: currentEnd },
        new Date(),
      ),
    ).toBeNull();
  });
});
