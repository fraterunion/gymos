import type { BillingInterval } from '@prisma/client';
import type Stripe from 'stripe';

export function billingIntervalToStripeRecurring(
  interval: BillingInterval,
): Pick<Stripe.PriceCreateParams.Recurring, 'interval'> {
  switch (interval) {
    case 'MONTHLY':
      return { interval: 'month' };
    case 'YEARLY':
      return { interval: 'year' };
    case 'WEEKLY':
      return { interval: 'week' };
    default: {
      const _exhaustive: never = interval;
      return _exhaustive;
    }
  }
}

export function stripeIntervalToBillingInterval(
  interval: Stripe.Price.Recurring.Interval,
): BillingInterval {
  switch (interval) {
    case 'month':
      return 'MONTHLY';
    case 'year':
      return 'YEARLY';
    case 'week':
      return 'WEEKLY';
    case 'day':
      return 'MONTHLY';
    default: {
      const _exhaustive: never = interval;
      return _exhaustive;
    }
  }
}
