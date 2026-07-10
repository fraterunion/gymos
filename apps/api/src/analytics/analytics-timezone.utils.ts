import {
  addDaysToDateKey,
  getStudioLocalDateKey,
} from '../common/date/studio-local-date';

/** Validate IANA timezone before interpolating into SQL. */
export function assertStudioTimezone(timezone: string): string {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

/** Normalize PG `date` / `timestamp` row values to YYYY-MM-DD. */
export function toDateKey(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

/**
 * Fill daily financial trend buckets using studio-local calendar days so chart
 * totals reconcile with period KPIs.
 */
export function fillStudioLocalTrendDays(
  rows: { d: Date | string; amount_cents: bigint; payment_count: bigint }[],
  periodStart: Date,
  periodEnd: Date,
  timezone: string,
): { date: string; amountCents: number; paymentCount: number }[] {
  const rowMap = new Map(
    rows.map((r) => [
      toDateKey(r.d),
      {
        amountCents: Number(r.amount_cents),
        paymentCount: Number(r.payment_count),
      },
    ]),
  );

  const startKey = getStudioLocalDateKey(periodStart, timezone);
  const endKey = getStudioLocalDateKey(periodEnd, timezone);
  const result: { date: string; amountCents: number; paymentCount: number }[] = [];

  let key = startKey;
  while (key <= endKey) {
    const entry = rowMap.get(key) ?? { amountCents: 0, paymentCount: 0 };
    result.push({ date: key, ...entry });
    key = addDaysToDateKey(key, 1);
  }

  return result;
}
