export type BillingPeriodBounds = {
  start: Date;
  end: Date;
};

/**
 * Resolves the subscription billing period that contains `classStartsAt`.
 *
 * Uses stored Stripe period bounds when the class falls inside them. When the
 * class is in an earlier period (historical backfill), walks backward by the
 * stored period length until the class date is contained or resolution fails.
 *
 * Limitation: only one period length is known (current period). Assumes
 * consistent-length billing periods (typical Stripe monthly/annual).
 */
export function resolveBillingPeriodForClassDate(
  subscription: {
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
  },
  classStartsAt: Date,
): BillingPeriodBounds | null {
  const { currentPeriodStart, currentPeriodEnd } = subscription;
  if (!currentPeriodStart || !currentPeriodEnd) {
    return null;
  }

  const periodMs = currentPeriodEnd.getTime() - currentPeriodStart.getTime();
  if (periodMs <= 0) {
    return null;
  }

  let start = new Date(currentPeriodStart);
  let end = new Date(currentPeriodEnd);

  if (classStartsAt >= start && classStartsAt < end) {
    return { start, end };
  }

  // Walk backward for historical classes (e.g. July class recorded in August).
  const maxSteps = 24;
  for (let step = 0; step < maxSteps && classStartsAt < start; step++) {
    end = start;
    start = new Date(start.getTime() - periodMs);
    if (classStartsAt >= start && classStartsAt < end) {
      return { start, end };
    }
  }

  // Future class beyond current period end — walk forward.
  for (let step = 0; step < maxSteps && classStartsAt >= end; step++) {
    start = end;
    end = new Date(end.getTime() + periodMs);
    if (classStartsAt >= start && classStartsAt < end) {
      return { start, end };
    }
  }

  return null;
}
