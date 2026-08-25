/**
 * Cash membership period construction for Admin walk-in sales.
 *
 * Never derive "today" via `toISOString().slice(0, 10)` + local noon — that rolls
 * evening America/Mexico_City sales into the next UTC calendar day and a future
 * entitlement start (NOT_STARTED until noon).
 *
 * Self-contained for `node --test` (mirrors @gymos/utils studio-local anchors).
 */

export type CashBillingInterval = 'MONTHLY' | 'YEARLY' | 'WEEKLY';

function calendarDayKeyInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function shiftDateKey(dayKey: string, deltaDays: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function getTimezoneOffsetMs(utcInstant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(utcInstant);

  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  const localAsUtcMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );

  return localAsUtcMs - utcInstant.getTime();
}

/** UTC instant for studio-local midnight on a YYYY-MM-DD key. */
function studioLocalDateKeyToUtcAnchor(dateKey: string, timezone: string): Date {
  const [yearStr, monthStr, dayStr] = dateKey.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const utcMidnight = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offsetMs = getTimezoneOffsetMs(utcMidnight, timezone);
  return new Date(utcMidnight.getTime() - offsetMs);
}

export function addBillingInterval(start: Date, interval: CashBillingInterval): Date {
  const end = new Date(start.getTime());
  if (interval === 'MONTHLY') end.setMonth(end.getMonth() + 1);
  else if (interval === 'YEARLY') end.setFullYear(end.getFullYear() + 1);
  else end.setDate(end.getDate() + 7);
  return end;
}

export function addEntitlementDays(start: Date, entitlementDays: number): Date {
  return new Date(start.getTime() + entitlementDays * 86_400_000);
}

export function immediateCashSalePeriod(params: {
  billingInterval: CashBillingInterval;
  entitlementDays?: number | null;
  now?: Date;
}): { periodStart: Date; periodEnd: Date } {
  const periodStart = params.now ?? new Date();
  const periodEnd =
    params.entitlementDays != null
      ? addEntitlementDays(periodStart, params.entitlementDays)
      : addBillingInterval(periodStart, params.billingInterval);
  return { periodStart, periodEnd };
}

export function formatCashSalePeriodLabel(
  periodStart: Date,
  periodEnd: Date,
  timeZone: string,
): { startKey: string; endKey: string; label: string } {
  const startKey = calendarDayKeyInZone(periodStart.toISOString(), timeZone);
  const endKey = calendarDayKeyInZone(periodEnd.toISOString(), timeZone);
  return { startKey, endKey, label: `${startKey} → ${endKey}` };
}

export type CashSalePeriodPayload =
  | { mode: 'immediate'; omitPeriod: true }
  | {
      mode: 'scheduled';
      omitPeriod: false;
      periodStartIso: string;
      periodEndIso: string;
    };

/**
 * Admin date-picker → API payload.
 * Same calendar day as "today" in the studio timezone → immediate (omit period;
 * API uses now / queues fixed-duration renewals).
 * Any other day → studio-local midnight anchors (intentional scheduling).
 */
export function resolveCashSalePeriodPayload(params: {
  periodStartDateKey: string;
  periodEndDateKey: string;
  timeZone: string;
  now?: Date;
}): CashSalePeriodPayload {
  const now = params.now ?? new Date();
  const todayKey = calendarDayKeyInZone(now.toISOString(), params.timeZone);
  if (params.periodStartDateKey === todayKey) {
    return { mode: 'immediate', omitPeriod: true };
  }
  const periodStart = studioLocalDateKeyToUtcAnchor(params.periodStartDateKey, params.timeZone);
  const dayAfterEnd = studioLocalDateKeyToUtcAnchor(
    shiftDateKey(params.periodEndDateKey, 1),
    params.timeZone,
  );
  const periodEnd = new Date(dayAfterEnd.getTime() - 1);
  return {
    mode: 'scheduled',
    omitPeriod: false,
    periodStartIso: periodStart.toISOString(),
    periodEndIso: periodEnd.toISOString(),
  };
}

export function periodEndDateKeyFromStart(
  periodStartDateKey: string,
  interval: CashBillingInterval,
  entitlementDays: number | null | undefined,
  timeZone: string,
): string {
  const start = studioLocalDateKeyToUtcAnchor(periodStartDateKey, timeZone);
  const end =
    entitlementDays != null
      ? addEntitlementDays(start, entitlementDays)
      : addBillingInterval(start, interval);
  return calendarDayKeyInZone(end.toISOString(), timeZone);
}
