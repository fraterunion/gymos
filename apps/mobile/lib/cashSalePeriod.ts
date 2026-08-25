/**
 * Cash membership period construction for Mobile Ventas.
 *
 * Never derive "today" via `toISOString().slice(0, 10)` + local noon — that rolls
 * evening America/Mexico_City sales into the next UTC calendar day and a future
 * entitlement start (NOT_STARTED until noon).
 *
 * Self-contained for `node --test` (no Metro path aliases).
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

/**
 * Preview period for an immediate cash sale (starts at transaction time).
 * Prefer omitting periodStart/periodEnd on the API body so the backend can apply
 * fixed-duration early-renewal queueing when periodStart is absent.
 */
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

/**
 * Proven anti-pattern: UTC calendar date + device-local noon.
 * Kept for regression tests only — do not use in product code.
 */
export function legacyBrokenUtcDateLocalNoonPeriodStart(now: Date): string {
  const periodStart = now.toISOString().slice(0, 10);
  return new Date(`${periodStart}T12:00:00`).toISOString();
}
