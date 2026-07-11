import type Stripe from 'stripe';
import type { WebhookInvoicePayload } from './stripe-webhook-payloads';

/**
 * Pre-basil webhook payloads and stored events may still carry subscription on the
 * invoice root. Stripe Basil SDK types omit that field — read via unknown guard.
 */
export type LegacyInvoiceSubscriptionShape = {
  subscription?: string | { id?: string } | null;
};

type BasilInvoiceParentShape = {
  parent?: {
    subscription_details?: {
      subscription?: string | { id?: string } | null;
    } | null;
  } | null;
};

/**
 * Legacy priority: when both legacy and Basil shapes are present, legacy wins.
 * This matches historical webhook handling and stored pre-basil payloads.
 */
export function pickInvoiceSubscriptionId(
  legacy: string | null,
  basil: string | null,
): string | null {
  return legacy ?? basil;
}

function readBasilSubscriptionRef(
  ref: string | { id?: string } | null | undefined,
): string | null {
  if (typeof ref === 'string' && ref.length > 0) {
    return ref;
  }
  if (typeof ref === 'object' && ref !== null) {
    const id = ref.id;
    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
  }
  return null;
}

export function readLegacyInvoiceSubscriptionId(invoice: unknown): string | null {
  if (typeof invoice !== 'object' || invoice === null) {
    return null;
  }

  const sub = (invoice as LegacyInvoiceSubscriptionShape).subscription;

  if (typeof sub === 'string') {
    return sub.length > 0 ? sub : null;
  }

  if (typeof sub === 'object' && sub !== null) {
    const id = sub.id;
    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
  }

  return null;
}

export function readBasilInvoiceSubscriptionId(invoice: BasilInvoiceParentShape): string | null {
  return readBasilSubscriptionRef(invoice.parent?.subscription_details?.subscription);
}

function readLegacyFromWebhookPayload(invoice: WebhookInvoicePayload): string | null {
  if (typeof invoice.subscription === 'string') {
    return invoice.subscription.length > 0 ? invoice.subscription : null;
  }
  if (invoice.subscription && typeof invoice.subscription !== 'string') {
    const id = invoice.subscription.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }
  return null;
}

/**
 * Resolves subscription ID from verified webhook invoice payloads (legacy + basil).
 */
export function readInvoiceSubscriptionId(invoice: WebhookInvoicePayload): string | null {
  const legacy = readLegacyFromWebhookPayload(invoice);
  const basil = readBasilInvoiceSubscriptionId(invoice);
  return pickInvoiceSubscriptionId(legacy, basil);
}

/**
 * Resolves subscription ID from Stripe API invoice objects (e.g. invoices.retrieve).
 * Legacy root subscription is checked via narrow unknown guard for backward compatibility.
 */
export function readStripeInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacy = readLegacyInvoiceSubscriptionId(invoice);
  const basil = readBasilSubscriptionRef(invoice.parent?.subscription_details?.subscription);
  return pickInvoiceSubscriptionId(legacy, basil);
}
