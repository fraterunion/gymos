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
};
