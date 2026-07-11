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
  cancel_at_period_end: boolean;
  // Stripe basil API (2025-08-27.basil) moved current_period_start/end from the
  // Subscription root to each SubscriptionItem. These are the canonical billing period.
  items: {
    data: Array<{
      price: { id: string } | null;
      current_period_start?: number | string | null;
      current_period_end?: number | string | null;
    }>;
  } | null;
};

export type WebhookInvoicePayload = {
  id: string;
  status: string | null;
  customer: string | { id: string } | null;
  // Present in pre-basil API (before 2025-08-27.basil); absent in basil invoices.
  // Use readInvoiceSubscriptionId() to resolve from either shape.
  subscription: string | { id: string } | null;
  // Absent in basil API invoices — payment intent is no longer embedded on the invoice.
  payment_intent: string | { id: string } | null;
  currency: string | null;
  amount_paid: number | null;
  amount_due: number | null;
  total: number | null;
  status_transitions: { paid_at: number | null } | null;
  lines: {
    data: Array<{ price: { id: string } | null }>;
  } | null;
  // Invoice collection-window timestamps — NOT the subscription billing period.
  // Do NOT use these for currentPeriodStart/currentPeriodEnd.
  period_start: number | null;
  period_end: number | null;
  // Stripe basil API (2025-08-27.basil) moved the subscription ID and metadata
  // from the invoice root to parent.subscription_details. Always read via
  // readInvoiceSubscriptionId() which handles both shapes.
  parent?: {
    type?: string | null;
    subscription_details?: {
      subscription?: string | null;
      metadata?: Record<string, string> | null;
    } | null;
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
