import type { Logger } from '@nestjs/common';

/**
 * Structured, PII-free lifecycle events for the Day Pass purchase flow.
 *
 * One JSON line per event so Railway log search / alerting can key on `event`.
 * Fields are identifiers and enums only: never emails, names, card data or Stripe secrets.
 *
 * Suggested metrics (derive from these lines; no metrics backend is wired in this API):
 *   day_pass_checkout_total{outcome=created|reused|replaced}
 *   day_pass_payment_total{outcome=succeeded|failed|canceled}
 *   day_pass_activated_total
 *   day_pass_conflict_total{reason=already_owned|attempt_in_progress|processing}
 *   day_pass_reconciled_total{action=...}
 *   day_pass_attempt_expired_total
 */
export type DayPassEventName =
  | 'DAY_PASS_CHECKOUT_CREATED'
  | 'DAY_PASS_CHECKOUT_REUSED'
  | 'DAY_PASS_CHECKOUT_REPLACED'
  | 'DAY_PASS_RETRY'
  | 'DAY_PASS_CONFLICT'
  | 'DAY_PASS_PAYMENT_SUCCEEDED'
  | 'DAY_PASS_PAYMENT_FAILED'
  | 'DAY_PASS_PAYMENT_CANCELED'
  | 'DAY_PASS_ACTIVATED'
  | 'DAY_PASS_ATTEMPT_EXPIRED'
  | 'DAY_PASS_RECONCILED'
  | 'DAY_PASS_WEBHOOK_IGNORED';

export type DayPassEventFields = {
  studioId?: string | null;
  userId?: string | null;
  dayPassId?: string | null;
  validForDate?: string | null;
  stripePaymentIntentId?: string | null;
  stripeStatus?: string | null;
  priceCents?: number | null;
  currency?: string | null;
  attemptCount?: number | null;
  reason?: string | null;
  errorCode?: string | null;
  declineCode?: string | null;
  source?: 'api' | 'webhook' | 'reconciliation' | 'sweep';
  eventId?: string | null;
  [extra: string]: unknown;
};

export function logDayPassEvent(
  logger: Logger,
  event: DayPassEventName,
  fields: DayPassEventFields,
  level: 'log' | 'warn' | 'error' = 'log',
): void {
  const line = JSON.stringify({ event, ...compact(fields) });
  if (level === 'warn') logger.warn(line);
  else if (level === 'error') logger.error(line);
  else logger.log(line);
}

function compact(fields: DayPassEventFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}
