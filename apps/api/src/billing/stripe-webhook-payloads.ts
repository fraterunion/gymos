/**
 * Narrow shapes read from Stripe webhook payloads after signature verification.
 * Kept explicit to avoid TS collisions between Prisma's `Subscription` model and Stripe types.
 */
export type WebhookCheckoutSessionPayload = {
  id: string;
  mode: string | null;
  payment_status: string | null;
  subscription: string | { id: string } | null;
  metadata: Record<string, string> | null;
};

export type WebhookSubscriptionPayload = {
  id: string;
  status: string;
  customer: string | { id: string } | null;
  metadata: Record<string, string> | null;
  // current_period_start / current_period_end were removed from Subscription
  // in the Stripe basil API (2025-08-27.basil). Billing period is now sourced
  // from Invoice.period_start / period_end via the invoice.paid webhook.
  cancel_at_period_end: boolean;
  items: {
    data: Array<{ price: { id: string } | null }>;
  } | null;
};

export type WebhookInvoicePayload = {
  id: string;
  status: string | null;
  customer: string | { id: string } | null;
  subscription: string | { id: string } | null;
  payment_intent: string | { id: string } | null;
  currency: string | null;
  amount_paid: number | null;
  amount_due: number | null;
  total: number | null;
  status_transitions: { paid_at: number | null } | null;
  lines: {
    data: Array<{ price: { id: string } | null }>;
  } | null;
  /// Unix timestamp (seconds) for the start of the billing period this invoice covers.
  period_start: number | null;
  /// Unix timestamp (seconds) for the end of the billing period this invoice covers.
  /// Equal to the subscription's next renewal date.
  period_end: number | null;
};

export type WebhookPaymentIntentPayload = {
  id: string;
  status: string;
  /** Unix timestamp (seconds) when the PaymentIntent was created. */
  created: number;
  amount: number | null;
  currency: string | null;
  customer: string | { id: string } | null;
  metadata: Record<string, string> | null;
};
