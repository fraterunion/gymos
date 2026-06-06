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
  current_period_start: number;
  current_period_end: number;
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
