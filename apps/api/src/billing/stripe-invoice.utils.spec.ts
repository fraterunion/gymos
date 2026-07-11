import type Stripe from 'stripe';
import type { WebhookInvoicePayload } from './stripe-webhook-payloads';
import {
  readInvoiceSubscriptionId,
  readLegacyInvoiceSubscriptionId,
  readStripeInvoiceSubscriptionId,
} from './stripe-invoice.utils';

function basilWebhookInvoice(
  overrides: Partial<WebhookInvoicePayload> = {},
): WebhookInvoicePayload {
  return {
    id: 'in_basil',
    status: 'paid',
    customer: 'cus_test',
    subscription: null,
    payment_intent: null,
    currency: 'mxn',
    amount_paid: 60000,
    amount_due: 60000,
    total: 60000,
    status_transitions: { paid_at: 1782764245 },
    lines: null,
    period_start: null,
    period_end: null,
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: 'sub_basil',
        metadata: null,
      },
    },
    ...overrides,
  };
}

function legacyWebhookInvoice(
  overrides: Partial<WebhookInvoicePayload> = {},
): WebhookInvoicePayload {
  return {
    id: 'in_legacy',
    status: 'paid',
    customer: 'cus_test',
    subscription: 'sub_legacy',
    payment_intent: 'pi_legacy',
    currency: 'usd',
    amount_paid: 5000,
    amount_due: 5000,
    total: 5000,
    status_transitions: { paid_at: 1782764245 },
    lines: null,
    period_start: null,
    period_end: null,
    ...overrides,
  };
}

function basilStripeInvoice(subscriptionId: string): Stripe.Invoice {
  return {
    id: 'in_sdk_basil',
    object: 'invoice',
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: subscriptionId,
      },
    },
  } as Stripe.Invoice;
}

describe('readInvoiceSubscriptionId (webhook payloads)', () => {
  it('returns legacy string subscription', () => {
    expect(readInvoiceSubscriptionId(legacyWebhookInvoice())).toBe('sub_legacy');
  });

  it('returns legacy expanded subscription object id', () => {
    const inv = legacyWebhookInvoice({ subscription: { id: 'sub_expanded' } });
    expect(readInvoiceSubscriptionId(inv)).toBe('sub_expanded');
  });

  it('returns basil parent.subscription_details.subscription', () => {
    expect(readInvoiceSubscriptionId(basilWebhookInvoice())).toBe('sub_basil');
  });

  it('prefers legacy string over basil when both present', () => {
    const inv = basilWebhookInvoice({ subscription: 'sub_legacy_wins' });
    expect(readInvoiceSubscriptionId(inv)).toBe('sub_legacy_wins');
  });

  it('returns null when both shapes are absent', () => {
    const inv = basilWebhookInvoice({ subscription: null, parent: null });
    expect(readInvoiceSubscriptionId(inv)).toBeNull();
  });

  it('returns null when basil subscription_details is null', () => {
    const inv = basilWebhookInvoice({
      subscription: null,
      parent: { type: 'subscription_details', subscription_details: null },
    });
    expect(readInvoiceSubscriptionId(inv)).toBeNull();
  });

  it('returns null when basil subscription is empty string', () => {
    const inv = basilWebhookInvoice({
      subscription: null,
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: '', metadata: null },
      },
    });
    expect(readInvoiceSubscriptionId(inv)).toBeNull();
  });
});

describe('readStripeInvoiceSubscriptionId (Stripe SDK Invoice)', () => {
  it('returns basil parent.subscription_details.subscription', () => {
    expect(readStripeInvoiceSubscriptionId(basilStripeInvoice('sub_sdk'))).toBe('sub_sdk');
  });

  it('returns null when basil subscription is missing', () => {
    expect(
      readStripeInvoiceSubscriptionId({
        id: 'in_empty',
        object: 'invoice',
      } as Stripe.Invoice),
    ).toBeNull();
  });
});

describe('readLegacyInvoiceSubscriptionId (unknown guard)', () => {
  it('reads legacy root subscription string from plain objects', () => {
    expect(readLegacyInvoiceSubscriptionId({ subscription: 'sub_plain' })).toBe('sub_plain');
  });

  it('reads legacy expanded subscription id from plain objects', () => {
    expect(readLegacyInvoiceSubscriptionId({ subscription: { id: 'sub_obj' } })).toBe('sub_obj');
  });

  it('returns null for missing subscription', () => {
    expect(readLegacyInvoiceSubscriptionId({})).toBeNull();
    expect(readLegacyInvoiceSubscriptionId(null)).toBeNull();
    expect(readLegacyInvoiceSubscriptionId('bad')).toBeNull();
  });

  it('returns null for malformed legacy values', () => {
    expect(readLegacyInvoiceSubscriptionId({ subscription: '' })).toBeNull();
    expect(readLegacyInvoiceSubscriptionId({ subscription: 42 })).toBeNull();
    expect(readLegacyInvoiceSubscriptionId({ subscription: { id: '' } })).toBeNull();
    expect(readLegacyInvoiceSubscriptionId({ subscription: { id: 99 } })).toBeNull();
    expect(readLegacyInvoiceSubscriptionId({ subscription: {} })).toBeNull();
  });
});
