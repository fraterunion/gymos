import type Stripe from 'stripe';

/**
 * Stripe invoice line items: ONE runtime-validated reader for every API shape GymOS receives.
 *
 * Verified production facts (2026-10-07 incident audit):
 * - The live webhook endpoint is pinned to `2026-05-27.dahlia`; older stored events are
 *   `2026-02-25.clover`. The SDK client is pinned to `2025-08-27.basil` (stripe.service.ts).
 * - Since `2025-03-31.basil` a line carries its Price at `pricing.price_details.price` (plus
 *   `.product`) and its subscription linkage + proration flag under
 *   `parent.subscription_item_details` (or `parent.invoice_item_details` for a one-off invoice
 *   item). There is NO top-level `price`, `proration` or `type`, and from clover onwards no
 *   top-level `subscription` either. This module calls that family the "basil" shape.
 * - Pre-basil ("legacy") lines carry `price` (object), `proration`, `type`
 *   ('subscription' | 'invoiceitem'), `subscription` and `subscription_item` at the top level.
 *
 * Reading the legacy `line.price.id` from a dahlia payload yields `undefined`; that is how two
 * paid Booty Lab renewals on 2026-10-02 lost their entitlement. Consumers must therefore never
 * index raw line objects: they call `parseInvoiceLines`, which validates each field at runtime and
 * reports unsupported shapes as explicit, actionable failures instead of silently missing data.
 */

/** Stripe SDK (basil) line type — accepted as input so API-retrieved invoices parse identically. */
export type SdkInvoiceLineItem = Stripe.InvoiceLineItem;

export type InvoiceLineShape = 'basil' | 'legacy';

/** `subscription_item` = recurring service line; `invoice_item` = one-off item (fees, credits). */
export type InvoiceLineKind = 'subscription_item' | 'invoice_item';

export type ParsedInvoiceLine = {
  id: string | null;
  shape: InvoiceLineShape;
  kind: InvoiceLineKind;
  priceId: string | null;
  productId: string | null;
  /** Stripe subscription this line belongs to, as declared by the line itself. */
  subscriptionId: string | null;
  subscriptionItemId: string | null;
  invoiceItemId: string | null;
  proration: boolean;
  /** Unix seconds. */
  periodStart: number;
  /** Unix seconds. */
  periodEnd: number;
  /** Line `amount` in the smallest currency unit (gross for prorations/invoice items since clover). */
  amount: number;
  /** `subtotal` — before discounts and taxes (added in 2025-12-15.clover); null on older shapes. */
  subtotal: number | null;
  /** What the period was priced at before discounts: `subtotal` when present, else `amount`. */
  grossAmount: number;
  currency: string | null;
};

/** `kind` is set when the line type was recognised before validation failed. */
export type InvoiceLineParseFailure = { id: string | null; reason: string; kind?: InvoiceLineKind };

export type InvoiceLineParseResult =
  | { ok: true; line: ParsedInvoiceLine }
  | ({ ok: false } & InvoiceLineParseFailure);

export type ParsedInvoiceLines = {
  lines: ParsedInvoiceLine[];
  failures: InvoiceLineParseFailure[];
  /** Stripe embeds only the first page of lines in an invoice; true when more exist. */
  hasMore: boolean;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a Stripe reference that may be an id string or an expanded `{ id }` object. */
function readStripeRef(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (isRecord(value) && typeof value['id'] === 'string' && value['id'].length > 0) return value['id'];
  return null;
}

function readPeriod(value: unknown): { start: number; end: number } | null {
  if (!isRecord(value)) return null;
  const start = value['start'];
  const end = value['end'];
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  // Stripe documents one-off invoice-item periods with end === start; only end < start is invalid.
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) return null;
  return { start, end };
}

function hasBasilMarkers(raw: UnknownRecord): boolean {
  return isRecord(raw['parent']) || isRecord(raw['pricing']);
}

/** Fields that only exist on pre-basil lines; seeing one next to basil fields is a mixed shape. */
function hasLegacyPricingMarkers(raw: UnknownRecord): boolean {
  return (raw['price'] !== undefined && raw['price'] !== null) || typeof raw['proration'] === 'boolean';
}

function fail(id: string | null, reason: string, kind?: InvoiceLineKind): InvoiceLineParseResult {
  return kind ? { ok: false, id, reason, kind } : { ok: false, id, reason };
}

function basilKind(raw: UnknownRecord): InvoiceLineKind | undefined {
  const parent = raw['parent'];
  if (!isRecord(parent)) return undefined;
  if (parent['type'] === 'subscription_item_details') return 'subscription_item';
  if (parent['type'] === 'invoice_item_details') return 'invoice_item';
  return undefined;
}

function legacyKind(raw: UnknownRecord): InvoiceLineKind | undefined {
  if (raw['type'] === 'subscription') return 'subscription_item';
  if (raw['type'] === 'invoiceitem') return 'invoice_item';
  return undefined;
}

/**
 * Parses one invoice line. Never throws: unsupported or incomplete shapes come back as an
 * explicit failure with a reason that is safe to log (ids and field names only).
 */
export function parseInvoiceLine(raw: unknown): InvoiceLineParseResult {
  if (!isRecord(raw)) return fail(null, 'line is not an object');
  const id = typeof raw['id'] === 'string' ? raw['id'] : null;

  const basil = hasBasilMarkers(raw);
  const legacy = !basil && (hasLegacyPricingMarkers(raw) || typeof raw['type'] === 'string');
  const kind = basil ? basilKind(raw) : legacyKind(raw);
  if (basil && hasLegacyPricingMarkers(raw)) {
    return fail(id, 'mixed shape: legacy price/proration fields next to basil parent/pricing', kind);
  }
  if (!basil && !legacy) {
    return fail(id, 'unrecognized shape: neither parent/pricing nor price/proration/type is present');
  }

  const period = readPeriod(raw['period']);
  if (!period) return fail(id, 'missing or invalid period (start/end)', kind);
  const amount = raw['amount'];
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return fail(id, 'missing or invalid amount', kind);
  const subtotal = typeof raw['subtotal'] === 'number' && Number.isFinite(raw['subtotal']) ? raw['subtotal'] : null;
  const currency = typeof raw['currency'] === 'string' ? raw['currency'].toLowerCase() : null;
  const money = { amount, subtotal, grossAmount: subtotal ?? amount, currency };

  return basil ? parseBasilLine(raw, id, period, money) : parseLegacyLine(raw, id, period, money);
}

type LineMoney = { amount: number; subtotal: number | null; grossAmount: number; currency: string | null };

function parseBasilLine(
  raw: UnknownRecord,
  id: string | null,
  period: { start: number; end: number },
  money: LineMoney,
): InvoiceLineParseResult {
  const parent = raw['parent'];
  if (!isRecord(parent)) return fail(id, 'basil line without parent');

  const parentType = parent['type'];
  let kind: InvoiceLineKind;
  let details: unknown;
  if (parentType === 'subscription_item_details') {
    kind = 'subscription_item';
    details = parent['subscription_item_details'];
  } else if (parentType === 'invoice_item_details') {
    kind = 'invoice_item';
    details = parent['invoice_item_details'];
  } else {
    return fail(id, `unsupported parent.type ${JSON.stringify(parentType ?? null)}`);
  }
  if (!isRecord(details)) return fail(id, `parent.${String(parentType)} is missing`, kind);

  const proration = details['proration'];
  if (typeof proration !== 'boolean') return fail(id, `parent.${String(parentType)}.proration is missing`, kind);

  let priceId: string | null = null;
  let productId: string | null = null;
  const pricing = raw['pricing'];
  if (isRecord(pricing)) {
    if (pricing['type'] === 'price_details' && isRecord(pricing['price_details'])) {
      priceId = readStripeRef(pricing['price_details']['price']);
      productId = readStripeRef(pricing['price_details']['product']);
    } else if (kind === 'subscription_item') {
      return fail(
        id,
        pricing['type'] === 'price_details'
          ? 'pricing.price_details is missing on a subscription line'
          : `unsupported pricing.type ${JSON.stringify(pricing['type'] ?? null)} on a subscription line`,
        kind,
      );
    }
  } else if (pricing !== null && pricing !== undefined) {
    return fail(id, 'pricing is not an object', kind);
  }

  const subscriptionId = readStripeRef(details['subscription']);
  if (kind === 'subscription_item') {
    if (!priceId) return fail(id, 'subscription line without pricing.price_details.price', kind);
    if (!subscriptionId) return fail(id, 'subscription line without parent.subscription_item_details.subscription', kind);
  }

  return {
    ok: true,
    line: {
      id,
      shape: 'basil',
      kind,
      priceId,
      productId,
      subscriptionId,
      subscriptionItemId: kind === 'subscription_item' ? readStripeRef(details['subscription_item']) : null,
      invoiceItemId: readStripeRef(details['invoice_item']),
      proration,
      periodStart: period.start,
      periodEnd: period.end,
      ...money,
    },
  };
}

function parseLegacyLine(
  raw: UnknownRecord,
  id: string | null,
  period: { start: number; end: number },
  money: LineMoney,
): InvoiceLineParseResult {
  const type = raw['type'];
  let kind: InvoiceLineKind;
  if (type === 'subscription') kind = 'subscription_item';
  else if (type === 'invoiceitem') kind = 'invoice_item';
  else return fail(id, `unsupported legacy line type ${JSON.stringify(type ?? null)}`);

  const proration = raw['proration'];
  if (typeof proration !== 'boolean') return fail(id, 'legacy line without proration flag', kind);

  const price = raw['price'];
  const priceId = readStripeRef(price);
  const productId = isRecord(price) ? readStripeRef(price['product']) : null;
  if (kind === 'subscription_item' && !priceId) return fail(id, 'legacy subscription line without price', kind);

  return {
    ok: true,
    line: {
      id,
      shape: 'legacy',
      kind,
      priceId,
      productId,
      subscriptionId: readStripeRef(raw['subscription']),
      subscriptionItemId: readStripeRef(raw['subscription_item']),
      invoiceItemId: readStripeRef(raw['invoice_item']),
      proration,
      periodStart: period.start,
      periodEnd: period.end,
      ...money,
    },
  };
}

/** Parses an invoice `lines` list object (`{ data: [...], has_more }`) of any supported shape. */
export function parseInvoiceLines(linesList: unknown): ParsedInvoiceLines {
  if (linesList === null || linesList === undefined) {
    return { lines: [], failures: [], hasMore: false };
  }
  if (!isRecord(linesList) || !Array.isArray(linesList['data'])) {
    return { lines: [], failures: [{ id: null, reason: 'invoice lines list has no data array' }], hasMore: false };
  }
  const lines: ParsedInvoiceLine[] = [];
  const failures: InvoiceLineParseFailure[] = [];
  for (const raw of linesList['data']) {
    const result = parseInvoiceLine(raw);
    if (result.ok) lines.push(result.line);
    else failures.push(result.kind ? { id: result.id, reason: result.reason, kind: result.kind } : { id: result.id, reason: result.reason });
  }
  return { lines, failures, hasMore: linesList['has_more'] === true };
}
