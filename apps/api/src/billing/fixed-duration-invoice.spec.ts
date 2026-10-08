import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyFixedDurationInvoice, type FixedDurationInvoiceFacts, type FixedDurationSubscriptionFacts } from './fixed-duration-invoice';

type RawLine = Record<string, unknown> & {
  parent: { type: string; subscription_item_details: Record<string, unknown> | null; invoice_item_details: Record<string, unknown> | null };
  pricing: { type: string; price_details: { price: string; product: string }; unit_amount_decimal: string } | null;
  period: { start: number; end: number };
};
type RawInvoice = {
  id: string; status: string; billing_reason: string; amount_paid: number;
  parent: { subscription_details: { subscription: string } };
  lines: { data: RawLine[]; has_more: boolean };
};

function fixtureInvoice(name: string): RawInvoice {
  const event = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/stripe-webhooks', `${name}.json`), 'utf8'));
  return event.data.object as RawInvoice;
}

const DAY = 86_400;
/** The real Oct 2 renewal line, adjustable field by field (deep copy). */
function line(overrides: {
  id?: string; priceId?: string; productId?: string; subscriptionId?: string | null; proration?: boolean;
  start?: number; days?: number; seconds?: number; amount?: number; subtotal?: number;
} = {}): RawLine {
  const base = structuredClone(fixtureInvoice('dahlia-invoice-paid-booty-renewal').lines.data[0]);
  const start = overrides.start ?? base.period.start;
  const length = overrides.seconds ?? (overrides.days ?? 45) * DAY;
  return {
    ...base,
    id: overrides.id ?? base['id'],
    amount: overrides.amount ?? base['amount'],
    subtotal: overrides.subtotal ?? overrides.amount ?? base['subtotal'],
    period: { start, end: start + length },
    pricing: {
      ...base.pricing!,
      price_details: { price: overrides.priceId ?? 'price_fx_booty_45d', product: overrides.productId ?? 'prod_fx_booty' },
    },
    parent: {
      ...base.parent,
      subscription_item_details: {
        ...base.parent.subscription_item_details!,
        subscription: overrides.subscriptionId === undefined ? 'sub_fx_booty_member' : overrides.subscriptionId,
        proration: overrides.proration ?? false,
      },
    },
  };
}
/** A one-off invoice item exactly as Stripe documents it: zero-length period (start === end). */
function feeLine(amount = 20000, overrides: { proration?: boolean; subscription?: string | null } = {}): Record<string, unknown> {
  return {
    id: 'il_fee', object: 'line_item', amount, subtotal: amount, currency: 'mxn', period: { start: 1790960080, end: 1790960080 },
    parent: {
      type: 'invoice_item_details',
      invoice_item_details: {
        invoice_item: 'ii_fee', proration: overrides.proration ?? false, proration_details: null,
        subscription: overrides.subscription === undefined ? 'sub_fx_booty_member' : overrides.subscription,
      },
      subscription_item_details: null,
    },
    pricing: { type: 'price_details', price_details: { price: 'price_fee', product: 'prod_fee' }, unit_amount_decimal: String(amount) },
  };
}

function facts(invoice: RawInvoice, overrides: Partial<FixedDurationInvoiceFacts> = {}): FixedDurationInvoiceFacts {
  return {
    invoiceId: invoice.id,
    status: invoice.status,
    billingReason: invoice.billing_reason,
    amountPaid: invoice.amount_paid,
    invoiceSubscriptionId: invoice.parent.subscription_details.subscription,
    lines: invoice.lines,
    ...overrides,
  };
}
function withLines(lines: unknown[], overrides: Partial<FixedDurationInvoiceFacts> = {}): FixedDurationInvoiceFacts {
  const invoice = fixtureInvoice('dahlia-invoice-paid-booty-renewal');
  return facts(invoice, { lines: { object: 'list', data: lines, has_more: false }, ...overrides });
}

const BOOTY: FixedDurationSubscriptionFacts = {
  stripeSubscriptionId: 'sub_fx_booty_member',
  plan: { entitlementDays: 45, classCredits: 4, stripePriceId: 'price_fx_booty_45d', stripeProductId: 'prod_fx_booty' },
};

describe('classifyFixedDurationInvoice — the Oct 2 Booty Lab renewal (real dahlia payload)', () => {
  it('grants exactly Oct 2 16:54:40Z to Nov 16 16:54:40Z with 4 credits', () => {
    const decision = classifyFixedDurationInvoice(facts(fixtureInvoice('dahlia-invoice-paid-booty-renewal')), BOOTY);
    expect(decision).toMatchObject({
      kind: 'grant',
      periodStart: new Date('2026-10-02T16:54:40.000Z'),
      periodEnd: new Date('2026-11-16T16:54:40.000Z'),
      creditLimit: 4,
      priceMatch: 'catalog_price',
    });
  });

  it('accepts the 1 s tolerance and rejects anything longer', () => {
    expect(classifyFixedDurationInvoice(withLines([line({ seconds: 45 * DAY + 1 })]), BOOTY).kind).toBe('grant');
    expect(classifyFixedDurationInvoice(withLines([line({ seconds: 45 * DAY + 2 })]), BOOTY)).toMatchObject({ kind: 'review', code: 'PERIOD_MISMATCH' });
  });
});

describe('classifyFixedDurationInvoice — historical (grandfathered) Prices', () => {
  it('renews a subscriber still billed at an older Price of the same plan product', () => {
    const catalogMoved: FixedDurationSubscriptionFacts = {
      ...BOOTY,
      plan: { ...BOOTY.plan, stripePriceId: 'price_fx_booty_45d_v2' }, // owner later changed the catalog price
    };
    const decision = classifyFixedDurationInvoice(facts(fixtureInvoice('dahlia-invoice-paid-booty-renewal')), catalogMoved);
    expect(decision).toMatchObject({ kind: 'grant', priceMatch: 'plan_product', creditLimit: 4 });
  });

  it('renews a subscription sold as this plan even when its Price sits on another product (catalog drift)', () => {
    const drifted = withLines([line({ priceId: 'price_old_product', productId: 'prod_old' })], { invoiceSubscriptionPlanId: 'plan_booty' });
    expect(classifyFixedDurationInvoice(drifted, { ...BOOTY, planId: 'plan_booty' }))
      .toMatchObject({ kind: 'grant', priceMatch: 'subscription_metadata', creditLimit: 4 });
    // The checkout metadata must name THIS plan.
    expect(classifyFixedDurationInvoice({ ...drifted, invoiceSubscriptionPlanId: 'plan_full' }, { ...BOOTY, planId: 'plan_booty' }))
      .toMatchObject({ kind: 'review', code: 'PRICE_NOT_ASSOCIATED_WITH_PLAN' });
    // …and proves nothing while a scheduled plan change is pending (Stripe keeps the old planId).
    expect(classifyFixedDurationInvoice(drifted, { ...BOOTY, planId: 'plan_booty', hasPendingPlanChange: true }))
      .toMatchObject({ kind: 'review', code: 'PRICE_NOT_ASSOCIATED_WITH_PLAN' });
  });

    it('never accepts a Price from another product as this plan’s service', () => {
    const foreign = withLines([line({ priceId: 'price_full_access', productId: 'prod_full_access' })]);
    expect(classifyFixedDurationInvoice(foreign, BOOTY)).toMatchObject({ kind: 'review', code: 'PRICE_NOT_ASSOCIATED_WITH_PLAN' });
    // A priced period settled by a 100% discount is still value: refused loudly, never skipped.
    expect(classifyFixedDurationInvoice({ ...foreign, amountPaid: 0 }, BOOTY)).toMatchObject({ kind: 'review', code: 'PRICE_NOT_ASSOCIATED_WITH_PLAN' });
  });
});

describe('classifyFixedDurationInvoice — only this subscription’s service line counts', () => {
  it('ignores a line that belongs to another subscription (another membership)', () => {
    expect(classifyFixedDurationInvoice(withLines([line({ subscriptionId: 'sub_full_access' })]), BOOTY))
      .toMatchObject({ kind: 'review', code: 'NO_SERVICE_LINE' });
  });

  it('refuses an invoice that belongs to a different subscription', () => {
    expect(classifyFixedDurationInvoice(withLines([line()], { invoiceSubscriptionId: 'sub_other' }), BOOTY))
      .toMatchObject({ kind: 'review', code: 'SUBSCRIPTION_NOT_LINKED' });
    expect(classifyFixedDurationInvoice(withLines([line()]), { ...BOOTY, stripeSubscriptionId: null }))
      .toMatchObject({ kind: 'review', code: 'SUBSCRIPTION_NOT_LINKED' });
  });

  it('ignores prorations and one-off fees next to the real service line', () => {
    const decision = classifyFixedDurationInvoice(
      withLines([line({ id: 'il_credit', proration: true, amount: -26000, days: 15 }), feeLine(), line({ id: 'il_service' })]),
      BOOTY,
    );
    expect(decision).toMatchObject({ kind: 'grant' });
    expect(decision.kind === 'grant' && decision.line.id).toBe('il_service');
  });

  it('never grants from a one-off fee alone', () => {
    expect(classifyFixedDurationInvoice(withLines([feeLine()]), BOOTY)).toMatchObject({ kind: 'review', code: 'NO_SERVICE_LINE' });
  });

  it('lets a zero-length one-off fee ride on the renewal (Stripe-documented shape)', () => {
    const decision = classifyFixedDurationInvoice(withLines([line(), feeLine()], { amountPaid: 100000 }), BOOTY);
    expect(decision).toMatchObject({ kind: 'grant', periodStart: new Date('2026-10-02T16:54:40.000Z'), creditLimit: 4 });
  });

  it('treats basil prorations delivered as invoice items as an adjustment', () => {
    expect(classifyFixedDurationInvoice(withLines([feeLine(35000, { proration: true })]), BOOTY))
      .toMatchObject({ kind: 'skip', reason: 'proration_adjustment_only' });
  });

  it('treats real legacy prorations (type invoiceitem) as an adjustment', () => {
    const legacyProration = {
      type: 'invoiceitem', amount: 35000, currency: 'mxn', proration: true, subscription: 'sub_fx_booty_member',
      price: { id: 'price_fx_booty_45d', product: 'prod_fx_booty' }, invoice_item: 'ii_p', period: { start: 1790960080, end: 1790960080 + 20 * DAY },
    };
    expect(classifyFixedDurationInvoice(withLines([legacyProration]), BOOTY)).toMatchObject({ kind: 'skip', reason: 'proration_adjustment_only' });
  });

    it('treats a proration-only invoice as an adjustment, not a new period', () => {
    expect(classifyFixedDurationInvoice(withLines([line({ proration: true, days: 20, amount: 35000 })]), BOOTY))
      .toMatchObject({ kind: 'skip', reason: 'proration_adjustment_only' });
  });

  it('fails safe when two lines both qualify', () => {
    expect(classifyFixedDurationInvoice(withLines([line({ id: 'il_a' }), line({ id: 'il_b' })]), BOOTY))
      .toMatchObject({ kind: 'review', code: 'AMBIGUOUS_SERVICE_LINE' });
  });

  it('flags a paid period that does not match the plan duration', () => {
    expect(classifyFixedDurationInvoice(withLines([line({ days: 31 })]), BOOTY)).toMatchObject({ kind: 'review', code: 'PERIOD_MISMATCH' });
  });
});

describe('classifyFixedDurationInvoice — zero-value invoices', () => {
  it('skips the real Aug 20 trial bridge (amount 0, 43.58 days)', () => {
    expect(classifyFixedDurationInvoice(facts(fixtureInvoice('dahlia-invoice-paid-booty-trial-bridge')), BOOTY))
      .toMatchObject({ kind: 'skip', reason: 'trial_or_bridge_period' });
  });

  it('grants a fully discounted or credit-settled exact period (line priced, nothing collected)', () => {
    expect(classifyFixedDurationInvoice(withLines([line()], { amountPaid: 0 }), BOOTY)).toMatchObject({ kind: 'grant', creditLimit: 4 });
  });

  it('never grants a free exact-length trial, even when a fee was paid on the same invoice', () => {
    expect(classifyFixedDurationInvoice(withLines([line({ amount: 0 }), feeLine()], { amountPaid: 20000 }), BOOTY))
      .toMatchObject({ kind: 'skip', reason: 'unpaid_trial_service_line' });
    expect(classifyFixedDurationInvoice(withLines([line({ amount: 0 })], { amountPaid: 0 }), BOOTY))
      .toMatchObject({ kind: 'skip', reason: 'unpaid_trial_service_line' });
  });

  it('refuses loudly a discounted (zero-value) period that does not match the plan', () => {
    expect(classifyFixedDurationInvoice(withLines([line({ days: 31 })], { amountPaid: 0 }), BOOTY))
      .toMatchObject({ kind: 'review', code: 'PERIOD_MISMATCH' });
  });

  it('skips a zero-value invoice without any priced service period', () => {
    expect(classifyFixedDurationInvoice(withLines([feeLine(0)], { amountPaid: 0 }), BOOTY))
      .toMatchObject({ kind: 'skip', reason: 'zero_value_without_service_period' });
  });

  it('prices the period by subtotal (pre-discount) when Stripe reports a net amount of 0', () => {
    expect(classifyFixedDurationInvoice(withLines([line({ amount: 0, subtotal: 80000 })], { amountPaid: 0 }), BOOTY))
      .toMatchObject({ kind: 'grant', creditLimit: 4 });
  });
});

describe('classifyFixedDurationInvoice — fail-safe guards', () => {
  it('grants nothing for an unpaid invoice', () => {
    expect(classifyFixedDurationInvoice(withLines([line()], { status: 'open' }), BOOTY)).toMatchObject({ kind: 'skip', reason: 'invoice_not_paid' });
  });

  it('refuses unsupported line shapes on paid and zero-value invoices alike', () => {
    const mixed = { ...line(), price: { id: 'price_fx_booty_45d' } };
    expect(classifyFixedDurationInvoice(withLines([mixed]), BOOTY)).toMatchObject({ kind: 'review', code: 'UNSUPPORTED_LINE_SHAPE' });
    expect(classifyFixedDurationInvoice(withLines([mixed], { amountPaid: 0 }), BOOTY)).toMatchObject({ kind: 'review', code: 'UNSUPPORTED_LINE_SHAPE' });
  });

  it('refuses to conclude from a truncated line page', () => {
    const truncated = withLines([feeLine()]);
    expect(classifyFixedDurationInvoice({ ...truncated, lines: { data: [feeLine()], has_more: true } }, BOOTY))
      .toMatchObject({ kind: 'review', code: 'LINES_TRUNCATED' });
  });

  it('never trusts a truncated page, even when the first page holds a valid service line', () => {
    const page = withLines([line()]);
    expect(classifyFixedDurationInvoice({ ...page, lines: { data: [line()], has_more: true } }, BOOTY))
      .toMatchObject({ kind: 'review', code: 'LINES_TRUNCATED' });
  });

  it('a one-off item it cannot read never blocks the real service line', () => {
    const unreadableFee = { ...feeLine(), parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: 'ii_x' } } };
    expect(classifyFixedDurationInvoice(withLines([unreadableFee, line()]), BOOTY)).toMatchObject({ kind: 'grant' });
  });

    it('refuses an invalid plan duration', () => {
    expect(classifyFixedDurationInvoice(withLines([line()]), { ...BOOTY, plan: { ...BOOTY.plan, entitlementDays: 0 } }))
      .toMatchObject({ kind: 'review', code: 'INVALID_PLAN_DURATION' });
  });

  it('still reads pre-basil lines, falling back to the invoice linkage when a line omits it', () => {
    const start = 1790960080;
    const legacy = { type: 'subscription', amount: 80000, currency: 'mxn', price: { id: 'price_fx_booty_45d', product: 'prod_fx_booty' }, proration: false, period: { start, end: start + 45 * DAY } };
    expect(classifyFixedDurationInvoice(withLines([legacy]), BOOTY)).toMatchObject({ kind: 'grant', priceMatch: 'catalog_price' });
    expect(classifyFixedDurationInvoice(withLines([{ ...legacy, subscription: 'sub_other' }]), BOOTY))
      .toMatchObject({ kind: 'review', code: 'NO_SERVICE_LINE' });
  });

  it('reports PII-free line diagnostics for operators', () => {
    const decision = classifyFixedDurationInvoice(withLines([line({ days: 31 })]), BOOTY);
    expect(decision.lines).toEqual([expect.objectContaining({
      priceId: 'price_fx_booty_45d', subscriptionId: 'sub_fx_booty_member', linkedToSubscription: true,
      proration: false, periodSeconds: 31 * DAY, amount: 80000,
    })]);
  });
});
