import type { StudioDayPassSettings } from '@prisma/client';

export type DayPassFinancialIdentity = {
  priceCents: number;
  currency: string;
};

export function dayPassFinancialIdentityChanged(
  before: DayPassFinancialIdentity,
  after: DayPassFinancialIdentity,
): boolean {
  return (
    before.priceCents !== after.priceCents ||
    before.currency.toLowerCase() !== after.currency.toLowerCase()
  );
}

export function isStripeBackedDayPass(
  settings: Pick<StudioDayPassSettings, 'stripeProductId' | 'stripePriceId'>,
): boolean {
  return Boolean(settings.stripeProductId || settings.stripePriceId);
}

/** Deterministic Stripe Idempotency-Key for Day Pass one-time Price rotation. */
export function dayPassSalePriceIdempotencyKey(
  settingsId: string,
  identity: DayPassFinancialIdentity,
): string {
  return ['day-pass-price', settingsId, String(identity.priceCents), identity.currency.toLowerCase()].join(
    ':',
  );
}

/** Deterministic Stripe Idempotency-Key for Day Pass Product bootstrap. */
export function dayPassProductIdempotencyKey(studioId: string): string {
  return `day-pass-product:${studioId}`;
}

export type DayPassStripePriceMatchResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'amount' | 'currency' | 'inactive' | 'unexpected_recurring';
    };

/** Whether a Stripe Price matches the Day Pass current one-time sale configuration. */
export function stripePriceMatchesDayPass(
  price: {
    unit_amount: number | null;
    currency: string | null | undefined;
    active: boolean;
    recurring: unknown | null;
  },
  identity: DayPassFinancialIdentity,
): DayPassStripePriceMatchResult {
  if (!price.active) {
    return { ok: false, reason: 'inactive' };
  }
  if (price.recurring) {
    return { ok: false, reason: 'unexpected_recurring' };
  }
  if (price.unit_amount !== identity.priceCents) {
    return { ok: false, reason: 'amount' };
  }
  if ((price.currency ?? '').toLowerCase() !== identity.currency.toLowerCase()) {
    return { ok: false, reason: 'currency' };
  }
  return { ok: true };
}

export type DayPassIntegrityStatus =
  | 'healthy'
  | 'missing_price'
  | 'price_mismatch'
  | 'currency_mismatch'
  | 'invalid_price'
  | 'inactive_stripe_price'
  | 'fetch_error';

export function dayPassIntegrityFromMatch(
  match: DayPassStripePriceMatchResult,
): Exclude<DayPassIntegrityStatus, 'missing_price' | 'fetch_error'> {
  if (match.ok) return 'healthy';
  switch (match.reason) {
    case 'amount':
      return 'price_mismatch';
    case 'currency':
      return 'currency_mismatch';
    case 'inactive':
      return 'inactive_stripe_price';
    case 'unexpected_recurring':
      return 'invalid_price';
  }
}
