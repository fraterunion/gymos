/** Structured 409 when cash assignment hits a renewable Stripe subscription. */
export const STRIPE_RENEWABLE_CONFLICT_CODE = 'STRIPE_RENEWABLE_CONFLICT';

export const STRIPE_RENEWABLE_CONFLICT_MESSAGE =
  'Este miembro tiene una suscripción activa en Stripe.';

export type StripeResolution = 'cancel_immediately' | 'cancel_at_period_end';

export type StripeConflictPayload = {
  code: typeof STRIPE_RENEWABLE_CONFLICT_CODE;
  message: string;
  statusCode: 409;
  stripeConflict: {
    localSubscriptionId: string;
    stripeSubscriptionId: string;
    planId: string;
    planName: string;
    status: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    pendingCashTransitionId: string | null;
    allowedResolutions: StripeResolution[];
  };
};
