import {
  addDaysToDateKey,
  getStudioLocalDateKey,
} from '../common/date/studio-local-date';
import {
  fillStudioLocalTrendDays,
  toDateKey,
} from './analytics-timezone.utils';

describe('fillStudioLocalTrendDays', () => {
  const TZ = 'America/Mexico_City';

  it('fills missing days and sums to row totals', () => {
    const periodStart = new Date('2026-07-01T06:00:00.000Z');
    const periodEnd = new Date('2026-07-03T14:00:00.000Z');

    const filled = fillStudioLocalTrendDays(
      [
        { d: '2026-07-01', amount_cents: 10_000n, payment_count: 1n },
        { d: '2026-07-03', amount_cents: 5_000n, payment_count: 1n },
      ],
      periodStart,
      periodEnd,
      TZ,
    );

    expect(filled).toHaveLength(3);
    expect(filled[0]).toMatchObject({ date: '2026-07-01', amountCents: 10_000, paymentCount: 1 });
    expect(filled[1]).toMatchObject({ date: '2026-07-02', amountCents: 0, paymentCount: 0 });
    expect(filled[2]).toMatchObject({ date: '2026-07-03', amountCents: 5_000, paymentCount: 1 });

    const amountSum = filled.reduce((s, r) => s + r.amountCents, 0);
    const countSum = filled.reduce((s, r) => s + r.paymentCount, 0);
    expect(amountSum).toBe(15_000);
    expect(countSum).toBe(2);
  });

  it('uses studio-local date keys at period boundaries', () => {
    const instant = new Date('2026-07-10T14:00:00.000Z');
    const key = getStudioLocalDateKey(instant, TZ);
    expect(key).toBe('2026-07-10');
    expect(toDateKey('2026-07-10')).toBe('2026-07-10');
    expect(addDaysToDateKey(key, 1)).toBe('2026-07-11');
  });
});
