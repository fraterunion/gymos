import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInvoiceLine, parseInvoiceLines } from './stripe-invoice-lines';

/** Sanitized production payloads (see test/fixtures/stripe-webhooks/README.md). */
function fixture(name: string): { api_version: string; data: { object: Record<string, unknown> } } {
  return JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/stripe-webhooks', `${name}.json`), 'utf8'));
}
function firstLine(name: string): Record<string, unknown> {
  const invoice = fixture(name).data.object as { lines: { data: Array<Record<string, unknown>> } };
  return invoice.lines.data[0];
}

const PERIOD = { start: 1790960080, end: 1794848080 };

describe('parseInvoiceLine — production shapes', () => {
  it('reads the real dahlia renewal line: Price from pricing.price_details, linkage from parent', () => {
    const raw = firstLine('dahlia-invoice-paid-booty-renewal');
    // The exact field the old code read does not exist in production payloads.
    expect(raw).not.toHaveProperty('price');
    expect(raw).not.toHaveProperty('proration');
    expect(raw).not.toHaveProperty('subscription');

    const result = parseInvoiceLine(raw);
    expect(result).toEqual({
      ok: true,
      line: {
        id: 'il_fx0001',
        shape: 'basil',
        kind: 'subscription_item',
        priceId: 'price_fx_booty_45d',
        productId: 'prod_fx_booty',
        subscriptionId: 'sub_fx_booty_member',
        subscriptionItemId: 'si_fx_booty_member',
        invoiceItemId: null,
        proration: false,
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
        amount: 80000,
        subtotal: 80000,
        grossAmount: 80000,
        currency: 'mxn',
      },
    });
  });

  it('reads the real clover line (parent also carries license_fee_subscription_details: null)', () => {
    const result = parseInvoiceLine(firstLine('clover-invoice-paid'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.line).toMatchObject({ shape: 'basil', kind: 'subscription_item', proration: false });
    expect(result.line.priceId).toMatch(/^price_/);
    expect(result.line.subscriptionId).toMatch(/^sub_/);
  });

  it('reads a zero-amount trial line exactly as delivered', () => {
    const result = parseInvoiceLine(firstLine('dahlia-invoice-paid-booty-trial-bridge'));
    expect(result.ok && result.line.amount).toBe(0);
  });

  it('accepts an expanded Price object inside pricing.price_details (API retrieve with expand)', () => {
    const raw = { ...firstLine('dahlia-invoice-paid-booty-renewal'), pricing: { type: 'price_details', price_details: { price: { id: 'price_x' }, product: { id: 'prod_x' } } } };
    const result = parseInvoiceLine(raw);
    expect(result.ok && [result.line.priceId, result.line.productId]).toEqual(['price_x', 'prod_x']);
  });

  it('reads a basil one-off invoice item (e.g. an enrollment fee) as an invoice_item line', () => {
    // Shape per the installed SDK (stripe 18.5 InvoiceLineItem.Parent.InvoiceItemDetails) and the
    // Stripe API docs, which give one-off items a ZERO-LENGTH period (start === end).
    const result = parseInvoiceLine({
      id: 'il_fee', object: 'line_item', amount: 20000, currency: 'mxn', period: { start: 1790960080, end: 1790960080 },
      parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: 'ii_fee', proration: false, proration_details: null, subscription: 'sub_fx_booty_member' }, subscription_item_details: null },
      pricing: { type: 'price_details', price_details: { price: 'price_fee', product: 'prod_fee' }, unit_amount_decimal: '20000' },
    });
    expect(result.ok && result.line).toMatchObject({ kind: 'invoice_item', invoiceItemId: 'ii_fee', priceId: 'price_fee', subscriptionItemId: null });
  });
});

describe('parseInvoiceLine — legacy compatibility', () => {
  it('reads a pre-basil subscription line', () => {
    const result = parseInvoiceLine({
      id: 'il_legacy', object: 'line_item', type: 'subscription', amount: 80000, currency: 'MXN',
      price: { id: 'price_legacy', product: 'prod_legacy' }, proration: false,
      subscription: 'sub_legacy', subscription_item: 'si_legacy', period: PERIOD,
    });
    expect(result).toEqual({
      ok: true,
      line: {
        id: 'il_legacy', shape: 'legacy', kind: 'subscription_item', priceId: 'price_legacy', productId: 'prod_legacy',
        subscriptionId: 'sub_legacy', subscriptionItemId: 'si_legacy', invoiceItemId: null, proration: false,
        periodStart: PERIOD.start, periodEnd: PERIOD.end, amount: 80000, subtotal: null, grossAmount: 80000, currency: 'mxn',
      },
    });
  });

  it('detects legacy prorations and invoice items', () => {
    const proration = parseInvoiceLine({ type: 'subscription', amount: -100, price: { id: 'p' }, proration: true, period: PERIOD });
    const item = parseInvoiceLine({ type: 'invoiceitem', amount: 20000, price: { id: 'p_fee' }, proration: false, invoice_item: 'ii_1', period: PERIOD });
    expect(proration.ok && proration.line.proration).toBe(true);
    expect(item.ok && item.line.kind).toBe('invoice_item');
  });

  it('detects basil prorations from parent.subscription_item_details', () => {
    const raw = firstLine('dahlia-invoice-paid-booty-renewal') as { parent: { subscription_item_details: Record<string, unknown> } };
    const prorated = {
      ...raw,
      parent: { ...raw.parent, subscription_item_details: { ...raw.parent.subscription_item_details, proration: true } },
    };
    const result = parseInvoiceLine(prorated);
    expect(result.ok && result.line.proration).toBe(true);
  });
});

describe('parseInvoiceLine — Stripe-documented edge shapes', () => {
  it('accepts the exact invoice-item line from the Stripe API reference (start === end)', () => {
    const docsLine = {
      id: 'il_tmp_1Nzo1ZGgdF1VjufLzD1UUn9R', object: 'line_item', amount: 1000, currency: 'usd',
      description: 'My First Invoice Item (created for API docs)', discount_amounts: [], discountable: true, discounts: [],
      livemode: false, metadata: {},
      parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: 'ii_1Nzo1ZGgdF1VjufLzD1UUn9R', proration: false, proration_details: { credited_items: null }, subscription: null } },
      period: { end: 1696975413, start: 1696975413 },
      pricing: { price_details: { price: 'price_1NzlYfGgdF1VjufL0cVjLJVI', product: 'prod_OnMHDH6VBmYlTr' }, type: 'price_details', unit_amount_decimal: '1000' },
      quantity: 1, quantity_decimal: '1', taxes: [],
    };
    expect(parseInvoiceLine(docsLine)).toMatchObject({ ok: true, line: { kind: 'invoice_item', periodStart: 1696975413, periodEnd: 1696975413 } });
  });

  it('still rejects a period that ends before it starts', () => {
    expect(parseInvoiceLine({ ...firstLine('dahlia-invoice-paid-booty-renewal'), period: { start: 1790960080, end: 1790960079 } }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/period/) });
  });

  it('uses subtotal (pre-discount, clover+) as the gross amount and falls back to amount', () => {
    const raw = firstLine('dahlia-invoice-paid-booty-renewal');
    expect(parseInvoiceLine({ ...raw, amount: 0, subtotal: 80000 })).toMatchObject({ ok: true, line: { amount: 0, subtotal: 80000, grossAmount: 80000 } });
    const withoutSubtotal: Record<string, unknown> = { ...raw };
    delete withoutSubtotal['subtotal'];
    expect(parseInvoiceLine(withoutSubtotal)).toMatchObject({ ok: true, line: { subtotal: null, grossAmount: 80000 } });
  });

  it('is not fooled by a future top-level `type` field on a basil line', () => {
    expect(parseInvoiceLine({ ...firstLine('dahlia-invoice-paid-booty-renewal'), type: 'subscription' }).ok).toBe(true);
  });

  it('tags failures with the line kind when it was recognisable', () => {
    const raw = firstLine('dahlia-invoice-paid-booty-renewal') as { parent: Record<string, unknown> };
    const brokenItem = { ...raw, parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: 'ii_x' } } };
    expect(parseInvoiceLine(brokenItem)).toMatchObject({ ok: false, kind: 'invoice_item' });
  });
});

describe('parseInvoiceLine — unsupported shapes fail explicitly', () => {
  const dahlia = () => firstLine('dahlia-invoice-paid-booty-renewal');

  it.each([
    ['mixed basil + legacy fields', () => ({ ...dahlia(), price: { id: 'price_other' } }), /mixed shape/],
    ['neither basil nor legacy markers', () => ({ id: 'il_x', amount: 1, period: PERIOD }), /unrecognized shape/],
    ['unknown parent.type', () => ({ ...dahlia(), parent: { type: 'quote_details' } }), /unsupported parent\.type/],
    ['subscription line without pricing', () => ({ ...dahlia(), pricing: null }), /without pricing\.price_details\.price/],
    ['subscription line without linkage', () => {
      const raw = dahlia() as { parent: { subscription_item_details: Record<string, unknown> } };
      return { ...raw, parent: { ...raw.parent, subscription_item_details: { ...raw.parent.subscription_item_details, subscription: null } } };
    }, /without parent\.subscription_item_details\.subscription/],
    ['missing period', () => ({ ...dahlia(), period: null }), /period/],
    ['missing amount', () => ({ ...dahlia(), amount: undefined }), /amount/],
    ['legacy line without type', () => ({ price: { id: 'p' }, proration: false, amount: 1, period: PERIOD }), /legacy line type/],
    ['legacy line without proration flag', () => ({ type: 'subscription', price: { id: 'p' }, amount: 1, period: PERIOD }), /proration/],
    ['not an object', () => 'il_1', /not an object/],
  ])('%s', (_label, build, reason) => {
    const result = parseInvoiceLine(build());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

describe('parseInvoiceLines', () => {
  it('parses every line of a real invoice and reports has_more', () => {
    const invoice = fixture('dahlia-invoice-paid-booty-renewal').data.object as { lines: unknown };
    expect(parseInvoiceLines(invoice.lines)).toMatchObject({ failures: [], hasMore: false, lines: [{ priceId: 'price_fx_booty_45d' }] });
    expect(parseInvoiceLines({ data: [], has_more: true }).hasMore).toBe(true);
  });

  it('keeps good lines and lists the bad ones separately', () => {
    const invoice = fixture('dahlia-invoice-paid-booty-renewal').data.object as { lines: { data: unknown[] } };
    const result = parseInvoiceLines({ data: [...invoice.lines.data, { id: 'il_bad' }] });
    expect(result.lines).toHaveLength(1);
    expect(result.failures).toEqual([{ id: 'il_bad', reason: expect.stringMatching(/unrecognized shape/) }]);
  });

  it('treats a missing lines list as empty and a malformed one as a failure', () => {
    expect(parseInvoiceLines(null)).toEqual({ lines: [], failures: [], hasMore: false });
    expect(parseInvoiceLines({ object: 'list' }).failures).toHaveLength(1);
  });
});
