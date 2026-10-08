import { parseInvoiceLines, type InvoiceLineKind, type InvoiceLineShape, type ParsedInvoiceLine } from './stripe-invoice-lines';

/**
 * Decides whether a paid Stripe invoice carries exactly one paid service period for a
 * fixed-duration (entitlementDays) subscription. Pure: no I/O, no clock. Shared by the
 * invoice.paid webhook handler and the read-only recovery dry-run so both reach the same verdict.
 *
 * A line qualifies only when ALL of these hold:
 *   1. it is a subscription-item line (never a one-off invoice item such as an enrollment fee);
 *   2. it belongs to THIS subscription (line linkage, or the invoice's own linkage for legacy
 *      lines that do not declare one) — never another membership's subscription;
 *   3. it is not a proration adjustment;
 *   4. its service period is exactly `entitlementDays` long (±1 s);
 *   5. its Price belongs to this plan: the current catalog Price, OR any Price of the plan's
 *      Stripe Product, OR the Stripe subscription was sold as this plan (the `planId` GymOS wrote
 *      into the subscription metadata at checkout). (5b/5c) keep grandfathered subscribers —
 *      still billed at a historical Price after a catalog price change — renewing correctly.
 *      Nothing here changes what anyone pays.
 *   6. it was priced (gross `subtotal`, else `amount`, > 0 before discounts). A free trial /
 *      bridge line is never a paid period; a fully discounted or credit-settled line is.
 * Exactly one qualifying line is required; zero or several fail safe with a typed reason. A
 * truncated line page (`has_more`) is never trusted.
 */

export const FIXED_DURATION_PERIOD_TOLERANCE_SECONDS = 1;
const SECONDS_PER_DAY = 86_400;

/** Conditions that need a human (or a code fix) before access can be granted. */
export type FixedDurationReviewCode =
  | 'INVALID_PLAN_DURATION'
  | 'SUBSCRIPTION_NOT_LOCAL'
  | 'SUBSCRIPTION_NOT_LINKED'
  | 'UNSUPPORTED_LINE_SHAPE'
  | 'LINES_TRUNCATED'
  | 'AMBIGUOUS_SERVICE_LINE'
  | 'NO_SERVICE_LINE'
  | 'PERIOD_MISMATCH'
  | 'PRICE_NOT_ASSOCIATED_WITH_PLAN'
  | 'EXISTING_CYCLE_MISMATCH'
  | 'OVERLAPS_EXISTING_CYCLE'
  /** Retryable: Stripe already bills a fixed-duration plan the local row has not switched to yet. */
  | 'SUBSCRIPTION_PLAN_NOT_SYNCED'
  /** The local row was already replaced (e.g. Stripe→cash); granting would double the entitlement. */
  | 'SUBSCRIPTION_SUPERSEDED';

/** Invoices that legitimately grant nothing (no paid service period). */
export type FixedDurationSkipReason =
  | 'invoice_not_paid'
  | 'unpaid_trial_service_line'
  | 'trial_or_bridge_period'
  | 'proration_adjustment_only'
  | 'zero_value_without_service_period';

/** Thrown when a paid invoice cannot be turned into an entitlement cycle. */
export class FixedDurationEntitlementError extends Error {
  readonly code: FixedDurationReviewCode;
  readonly stripeInvoiceId: string;

  constructor(code: FixedDurationReviewCode, stripeInvoiceId: string, detail: string) {
    // The message is persisted as stripe_webhook_events.last_error — keep it ids-only (no PII).
    super(`[fixed-duration-entitlement:${code}] invoice ${stripeInvoiceId}: ${detail}`);
    this.name = 'FixedDurationEntitlementError';
    this.code = code;
    this.stripeInvoiceId = stripeInvoiceId;
  }
}

export type FixedDurationInvoiceFacts = {
  invoiceId: string;
  status: string | null;
  billingReason: string | null;
  amountPaid: number;
  /** Subscription the invoice belongs to (parent.subscription_details or legacy root field). */
  invoiceSubscriptionId: string | null;
  /** `planId` GymOS wrote into the Stripe subscription metadata at checkout, when present. */
  invoiceSubscriptionPlanId?: string | null;
  /** The raw `lines` list object exactly as received (any supported Stripe API shape). */
  lines: unknown;
};

export type FixedDurationPlanTerms = {
  entitlementDays: number;
  classCredits: number | null;
  stripePriceId: string | null;
  stripeProductId: string | null;
};

export type FixedDurationSubscriptionFacts = {
  stripeSubscriptionId: string | null;
  /** Local membership plan id (compared with the subscription's checkout metadata). */
  planId?: string | null;
  /** A scheduled plan change is pending: checkout metadata may name the outgoing plan. */
  hasPendingPlanChange?: boolean;
  plan: FixedDurationPlanTerms;
};

/** Safe, PII-free summary of a line for logs and reports. */
export type InvoiceLineDiagnostic = {
  id: string | null;
  shape: InvoiceLineShape;
  kind: InvoiceLineKind;
  priceId: string | null;
  productId: string | null;
  subscriptionId: string | null;
  linkedToSubscription: boolean;
  proration: boolean;
  periodSeconds: number;
  amount: number;
  grossAmount: number;
};

export type PriceMatch = 'catalog_price' | 'plan_product' | 'subscription_metadata';

export type FixedDurationDecision =
  | {
      kind: 'grant';
      line: ParsedInvoiceLine;
      periodStart: Date;
      periodEnd: Date;
      creditLimit: number | null;
      priceMatch: PriceMatch;
      lines: InvoiceLineDiagnostic[];
    }
  | { kind: 'skip'; reason: FixedDurationSkipReason; detail: string; lines: InvoiceLineDiagnostic[] }
  | { kind: 'review'; code: FixedDurationReviewCode; detail: string; lines: InvoiceLineDiagnostic[] };

export function classifyFixedDurationInvoice(
  invoice: FixedDurationInvoiceFacts,
  subscription: FixedDurationSubscriptionFacts,
): FixedDurationDecision {
  const { plan } = subscription;
  const localStripeSubscriptionId = subscription.stripeSubscriptionId;
  const parsed = parseInvoiceLines(invoice.lines);
  const paidMoney = invoice.amountPaid > 0;

  const lineSubscription = (line: ParsedInvoiceLine): string | null =>
    // Legacy lines may omit the field; the invoice-level linkage is then authoritative.
    line.subscriptionId ?? (line.shape === 'legacy' ? invoice.invoiceSubscriptionId : null);
  const belongsToSubscription = (line: ParsedInvoiceLine): boolean =>
    localStripeSubscriptionId !== null && lineSubscription(line) === localStripeSubscriptionId;
  const isLinked = (line: ParsedInvoiceLine): boolean => line.kind === 'subscription_item' && belongsToSubscription(line);
  // Checkout metadata only proves the plan while no plan change is pending (Stripe merges metadata,
  // so a scheduled change keeps the old planId); the service also refuses it when the billed
  // Price/Product belongs to another plan.
  const soldAsThisPlan =
    !subscription.hasPendingPlanChange &&
    !!subscription.planId && !!invoice.invoiceSubscriptionPlanId && invoice.invoiceSubscriptionPlanId === subscription.planId;
  const priceMatch = (line: ParsedInvoiceLine): PriceMatch | null => {
    if (plan.stripePriceId && line.priceId === plan.stripePriceId) return 'catalog_price';
    if (plan.stripeProductId && line.productId === plan.stripeProductId) return 'plan_product';
    if (soldAsThisPlan) return 'subscription_metadata';
    return null;
  };

  const lines: InvoiceLineDiagnostic[] = parsed.lines.map((line) => ({
    id: line.id,
    shape: line.shape,
    kind: line.kind,
    priceId: line.priceId,
    productId: line.productId,
    subscriptionId: lineSubscription(line),
    linkedToSubscription: isLinked(line),
    proration: line.proration,
    periodSeconds: line.periodEnd - line.periodStart,
    amount: line.amount,
    grossAmount: line.grossAmount,
  }));
  const review = (code: FixedDurationReviewCode, detail: string): FixedDurationDecision => ({ kind: 'review', code, detail, lines });
  const skip = (reason: FixedDurationSkipReason, detail: string): FixedDurationDecision => ({ kind: 'skip', reason, detail, lines });

  if (!Number.isInteger(plan.entitlementDays) || plan.entitlementDays <= 0) {
    return review('INVALID_PLAN_DURATION', `plan entitlementDays=${String(plan.entitlementDays)}`);
  }
  if (invoice.status !== 'paid') {
    return skip('invoice_not_paid', `invoice status is ${JSON.stringify(invoice.status)}`);
  }
  if (!localStripeSubscriptionId) {
    return review('SUBSCRIPTION_NOT_LINKED', 'local subscription has no Stripe subscription id');
  }
  if (invoice.invoiceSubscriptionId !== null && invoice.invoiceSubscriptionId !== localStripeSubscriptionId) {
    return review(
      'SUBSCRIPTION_NOT_LINKED',
      `invoice belongs to ${invoice.invoiceSubscriptionId}, local subscription is ${localStripeSubscriptionId}`,
    );
  }
  // A line we cannot read might be the service line; a one-off invoice item never is.
  const blockingFailures = parsed.failures.filter((f) => f.kind !== 'invoice_item');
  if (blockingFailures.length > 0) {
    return review('UNSUPPORTED_LINE_SHAPE', blockingFailures.map((f) => `${f.id ?? 'line'}: ${f.reason}`).join('; '));
  }
  if (parsed.hasMore) {
    return review('LINES_TRUNCATED', 'invoice embeds only its first page of lines; refusing to decide on a partial view');
  }

  const expectedSeconds = plan.entitlementDays * SECONDS_PER_DAY;
  const service = parsed.lines.filter((line) => isLinked(line) && !line.proration);
  const linkedProrations = parsed.lines.filter((line) => line.proration && belongsToSubscription(line));
  const exact = service.filter(
    (line) => Math.abs(line.periodEnd - line.periodStart - expectedSeconds) <= FIXED_DURATION_PERIOD_TOLERANCE_SECONDS,
  );
  const priced = exact.filter((line) => priceMatch(line) !== null);
  const paidService = priced.filter((line) => line.grossAmount > 0);
  // Money changed hands, or a priced service period was settled by discount / credit balance.
  const valueBearing = paidMoney || service.some((line) => line.grossAmount > 0);
  const mismatch = (code: FixedDurationReviewCode, detail: string): FixedDurationDecision =>
    valueBearing ? review(code, detail) : skip('zero_value_without_service_period', `${code}: ${detail}`);

  if (paidService.length === 1) {
    const line = paidService[0];
    return {
      kind: 'grant',
      line,
      periodStart: new Date(line.periodStart * 1000),
      periodEnd: new Date(line.periodEnd * 1000),
      creditLimit: plan.classCredits,
      priceMatch: priceMatch(line)!,
      lines,
    };
  }
  if (paidService.length > 1) {
    return review('AMBIGUOUS_SERVICE_LINE', `${paidService.length} lines each qualify as the ${plan.entitlementDays}-day service period`);
  }
  if (priced.length > 0) {
    return skip('unpaid_trial_service_line', 'the only service period on this invoice was not priced (trial)');
  }
  if (exact.length > 0) {
    return mismatch(
      'PRICE_NOT_ASSOCIATED_WITH_PLAN',
      `service line Price ${exact[0].priceId ?? 'none'} (product ${exact[0].productId ?? 'none'}) is neither the plan Price, a Price of the plan product, nor a subscription sold as this plan`,
    );
  }
  if (service.length > 0) {
    if (service.every((line) => line.grossAmount === 0)) {
      return skip('trial_or_bridge_period', 'non-priced service period that does not match the plan duration');
    }
    return mismatch(
      'PERIOD_MISMATCH',
      `service period lasts ${(service[0].periodEnd - service[0].periodStart) / SECONDS_PER_DAY} days, plan grants ${plan.entitlementDays}`,
    );
  }
  if (linkedProrations.length > 0) {
    return skip('proration_adjustment_only', 'only proration lines for this subscription');
  }
  return mismatch('NO_SERVICE_LINE', `no subscription line for ${localStripeSubscriptionId}`);
}
