/**
 * Staff-facing billing explanation for each membership (Member 360).
 *
 * Pure and deterministic. Callers load the facts — local rows, AuditLog, stored Stripe webhook
 * payloads and an optional read-only Stripe lookup — and this module classifies them into one
 * canonical state. Every explanation says how sure it is (`certainty`) and where the payment
 * failure detail came from (`detailSource`), so the UI never presents an inference as a fact.
 * Copy is the admin's job; this module only returns codes and facts.
 *
 * Staff-only: decline codes and Stripe risk outcomes must never reach the member app.
 */

export type BillingStateCode =
  /** Card membership, entitled, Stripe will charge the next period automatically. */
  | 'AUTO_RENEW_OK'
  /** Card membership, entitled, auto-renewal switched off: access continues until the end. */
  | 'RENEWAL_DISABLED'
  /** A charge failed and whether Stripe will try again could not be established. */
  | 'PAYMENT_FAILED'
  /** A charge failed and Stripe has another attempt scheduled (possibly already due). */
  | 'PAYMENT_FAILED_RETRYING'
  /** A charge failed and Stripe reported no further automatic attempt, or the invoice is closed. */
  | 'PAYMENT_FAILED_FINAL'
  /** The last attempt needs the cardholder to authenticate (3D Secure). */
  | 'PAYMENT_ACTION_REQUIRED'
  /** Payment pending without a recorded failed attempt (open invoice, first payment, fixed-term cycle). */
  | 'PAYMENT_PENDING'
  /** GymOS shows the invoice as failed, Stripe already shows it paid: needs reconciliation. */
  | 'INVOICE_PAID_IN_STRIPE'
  /** GymOS shows the subscription ended/paused/current while Stripe shows otherwise. */
  | 'STATUS_MISMATCH'
  /** Stripe cancelled the subscription because a payment could not be collected. */
  | 'CANCELED_PAYMENT_FAILED'
  /** Subscription cancelled (on request, after a dispute, or for a reason Stripe did not report). */
  | 'CANCELED'
  /** Renewal was off and the period ended without a new charge. */
  | 'ENDED_NOT_RENEWED'
  /** Card membership whose access ended with no renewal payment recorded in GymOS. */
  | 'EXPIRED_UNPAID'
  /** A card payment was recorded without its access cycle (2026-10 incident guard). */
  | 'PAID_WITHOUT_ENTITLEMENT'
  | 'MANUAL_ACTIVE'
  | 'MANUAL_EXPIRED'
  /** Ended because another membership replaced it (payment-method change, renewal, plan change). */
  | 'REPLACED'
  | 'SCHEDULED'
  | 'PAUSED'
  | 'UNKNOWN';

export type BillingSeverity = 'ok' | 'info' | 'warning' | 'critical';
export type BillingCertainty = 'confirmed' | 'inferred';

export type PaymentFailureReason =
  | 'INSUFFICIENT_FUNDS'
  | 'EXPIRED_CARD'
  | 'INCORRECT_CVC'
  | 'AUTHENTICATION_REQUIRED'
  /** Stripe's own fraud screening blocked the charge before it reached the bank. */
  | 'BLOCKED_BY_STRIPE'
  | 'CARD_NOT_SUPPORTED'
  | 'PROCESSING_ERROR'
  /** The issuing bank declined without a more specific, shareable reason. */
  | 'CARD_DECLINED'
  | 'NO_PAYMENT_METHOD'
  | 'OTHER'
  | 'UNKNOWN';

export type RenewalChangeOrigin =
  /** Changed from GymOS by staff: a GymOS renewal audit row names the actor. */
  | 'GYMOS_STAFF'
  /** Changed by a GymOS flow (GymOS idempotency key) without a staff actor, e.g. a plan change. */
  | 'GYMOS'
  /** GymOS stopped the card subscription to move the member to cash/manual payment. */
  | 'STRIPE_TO_CASH'
  /** Outside GymOS, no API request, and the customer answered Stripe's cancellation survey. */
  | 'CUSTOMER_PORTAL'
  /** Outside GymOS and without an API request (typically the customer portal), no survey answer. */
  | 'STRIPE_NO_REQUEST'
  /** Outside GymOS through an API request: the Stripe Dashboard or another integration. */
  | 'STRIPE_API'
  | 'UNKNOWN';

export type BillingAction =
  | 'UPDATE_PAYMENT_METHOD'
  | 'COMPLETE_AUTHENTICATION'
  | 'RENEW_MANUALLY'
  | 'REVIEW_BILLING'
  | 'RECONCILE';

// ── Facts (input) ─────────────────────────────────────────────────────────────

export type LocalMembershipFacts = {
  subscriptionId: string;
  planName: string;
  source: 'STRIPE' | 'CASH' | 'MANUAL';
  /** Raw SubscriptionStatus. */
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  endReason: string | null;
  /** From deriveMembershipLifecycle. */
  isEntitled: boolean;
  lifecycleStatus: string;
  effectiveEnd: Date | null;
  /** Plan grants access in fixed blocks (entitlementDays), e.g. Booty Lab 45 days. */
  fixedTerm: boolean;
  paidWithoutEntitlement: boolean;
};

/** Stripe's view of the subscription, from the newest stored webhook payload. */
export type StripeSubscriptionFacts = {
  status: string;
  cancelAtPeriodEnd: boolean;
  cancelAt: Date | null;
  canceledAt: Date | null;
  endedAt: Date | null;
  cancellationReason: string | null;
  cancellationFeedback: string | null;
  /** Event creation time of the payload these facts came from. */
  observedAt: Date;
};

export type RenewalChangeFact = {
  /** New cancel_at_period_end value (true = renewal switched off). */
  disabled: boolean;
  at: Date;
  origin: RenewalChangeOrigin;
  actorName: string | null;
  feedback: string | null;
  certainty: BillingCertainty;
};

/** Read-only Stripe snapshot of a failed invoice and its most recent payment attempt. */
export type LiveInvoiceFailure = {
  invoiceStatus: string | null;
  billingReason: string | null;
  attemptCount: number | null;
  nextPaymentAttemptAt: Date | null;
  amountRemaining: number | null;
  paymentIntentStatus: string | null;
  errorType: string | null;
  errorCode: string | null;
  declineCode: string | null;
  /** Charge outcome type: authorized, issuer_declined, blocked, invalid, manual_review. */
  outcomeType: string | null;
  outcomeReason: string | null;
  lastAttemptAt: Date | null;
  hasPaymentMethod: boolean | null;
};

export type StoredInvoiceFailure = {
  attemptCount: number | null;
  nextAttemptAt: Date | null;
  invoiceStatus: string | null;
  billingReason: string | null;
  at: Date;
};

export type FailedInvoiceFacts = {
  paymentId: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
  /** Payment.createdAt: the first failure GymOS recorded for this invoice. */
  firstFailedAt: Date;
  /** Newest stored invoice.payment_failed payload for this invoice. */
  stored: StoredInvoiceFailure | null;
  live: LiveInvoiceFailure | null;
  liveLookup: 'ok' | 'unavailable' | 'skipped';
};

// ── Explanation (output) ──────────────────────────────────────────────────────

export type PaymentFailureView = {
  paymentId: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
  firstFailedAt: string;
  lastAttemptAt: string | null;
  attemptCount: number | null;
  nextAttemptAt: string | null;
  invoiceStatus: string | null;
  /** Stripe billing_reason: subscription_cycle (renewal), subscription_create, subscription_update… */
  billingReason: string | null;
  reason: PaymentFailureReason;
  /** Raw Stripe code worth showing to staff (never for lost/stolen/fraud codes). */
  code: string | null;
  detailSource: 'stripe_live' | 'webhook_history' | 'local';
  liveLookup: 'ok' | 'unavailable' | 'skipped';
};

export type MembershipBillingStatus = {
  subscriptionId: string;
  planName: string;
  source: LocalMembershipFacts['source'];
  state: BillingStateCode;
  severity: BillingSeverity;
  certainty: BillingCertainty;
  isEntitled: boolean;
  lifecycleStatus: string;
  /** Local access end (entitlement). Use this for "access until" statements. */
  effectiveEnd: string | null;
  renewal: {
    mode: 'AUTOMATIC' | 'DISABLED' | 'MANUAL' | 'ENDED' | 'NONE';
    /** When the subscription stops if nothing changes (Stripe's end when it has one). */
    endsAt: string | null;
    /** Next automatic charge (AUTOMATIC only). */
    nextChargeAt: string | null;
    /** The newest renewal change, only when it agrees with the current renewal state. */
    change: {
      disabled: boolean;
      at: string;
      origin: RenewalChangeOrigin;
      actorName: string | null;
      feedback: string | null;
      certainty: BillingCertainty;
    } | null;
  };
  paymentFailure: PaymentFailureView | null;
  stripe: {
    status: string;
    cancellationReason: string | null;
    canceledAt: string | null;
    endedAt: string | null;
    cancelAt: string | null;
    observedAt: string;
  } | null;
  /** GymOS and Stripe disagree about the subscription's status. */
  statusMismatch: { local: string; stripe: string } | null;
  action: BillingAction | null;
};

// ── Payment failure classification ────────────────────────────────────────────

const INSUFFICIENT_FUNDS_CODES = new Set(['insufficient_funds']);
const EXPIRED_CARD_CODES = new Set(['expired_card']);
const CVC_CODES = new Set(['incorrect_cvc', 'invalid_cvc']);
const AUTHENTICATION_CODES = new Set(['authentication_required', 'payment_intent_authentication_failure']);
const NOT_SUPPORTED_CODES = new Set(['card_not_supported', 'currency_not_supported', 'transaction_not_allowed']);
const PROCESSING_CODES = new Set(['processing_error', 'issuer_not_available', 'try_again_later', 'reenter_transaction']);
/**
 * Stripe asks merchants not to reveal these to the cardholder (fraud signals). Staff see a
 * generic decline and no raw code, so nobody repeats "your card is reported stolen".
 */
const WITHHELD_CODES = new Set(['lost_card', 'stolen_card', 'pickup_card', 'fraudulent', 'merchant_blacklist', 'restricted_card']);

export function classifyPaymentFailure(live: LiveInvoiceFailure | null): { reason: PaymentFailureReason; code: string | null } {
  if (!live) return { reason: 'UNKNOWN', code: null };
  const decline = live.declineCode;
  const code = live.errorCode;
  const specific = decline ?? code;
  const withheld = specific !== null && WITHHELD_CODES.has(specific);
  const shareable = withheld ? null : specific;

  if (live.paymentIntentStatus === 'requires_action' || (specific !== null && AUTHENTICATION_CODES.has(specific)) || (code !== null && AUTHENTICATION_CODES.has(code))) {
    return { reason: 'AUTHENTICATION_REQUIRED', code: shareable };
  }
  if (live.outcomeType === 'blocked') return { reason: 'BLOCKED_BY_STRIPE', code: null };
  if (withheld) return { reason: 'CARD_DECLINED', code: null };
  if (specific !== null && INSUFFICIENT_FUNDS_CODES.has(specific)) return { reason: 'INSUFFICIENT_FUNDS', code: specific };
  if (specific !== null && EXPIRED_CARD_CODES.has(specific)) return { reason: 'EXPIRED_CARD', code: specific };
  if (specific !== null && CVC_CODES.has(specific)) return { reason: 'INCORRECT_CVC', code: specific };
  if (specific !== null && NOT_SUPPORTED_CODES.has(specific)) return { reason: 'CARD_NOT_SUPPORTED', code: specific };
  if (specific !== null && PROCESSING_CODES.has(specific)) return { reason: 'PROCESSING_ERROR', code: specific };
  if (live.errorType === 'card_error' || code === 'card_declined' || live.outcomeType === 'issuer_declined') {
    return { reason: 'CARD_DECLINED', code: decline ?? null };
  }
  if (
    specific === null &&
    live.paymentIntentStatus === 'requires_payment_method' &&
    live.hasPaymentMethod === false &&
    live.outcomeType === null
  ) {
    return { reason: 'NO_PAYMENT_METHOD', code: null };
  }
  if (specific !== null) return { reason: 'OTHER', code: specific };
  return { reason: 'UNKNOWN', code: null };
}

export function buildPaymentFailureView(f: FailedInvoiceFacts): PaymentFailureView {
  const live = f.liveLookup === 'ok' ? f.live : null;
  const classified = classifyPaymentFailure(live);
  return {
    paymentId: f.paymentId,
    invoiceId: f.invoiceId,
    amountCents: f.amountCents,
    currency: f.currency,
    firstFailedAt: f.firstFailedAt.toISOString(),
    lastAttemptAt: iso(live?.lastAttemptAt ?? f.stored?.at ?? null),
    attemptCount: live?.attemptCount ?? f.stored?.attemptCount ?? null,
    nextAttemptAt: live ? iso(live.nextPaymentAttemptAt) : iso(f.stored?.nextAttemptAt ?? null),
    invoiceStatus: live?.invoiceStatus ?? f.stored?.invoiceStatus ?? null,
    billingReason: live?.billingReason ?? f.stored?.billingReason ?? null,
    reason: classified.reason,
    code: classified.code,
    detailSource: live ? 'stripe_live' : f.stored ? 'webhook_history' : 'local',
    liveLookup: f.liveLookup,
  };
}

// ── Stored webhook payload readers ────────────────────────────────────────────

export type StoredStripeEvent = { eventType: string; createdAt: Date; payload: unknown };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const unixDate = (v: unknown): Date | null => {
  const n = num(v);
  return n === null ? null : new Date(n * 1000);
};
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Event creation time (Stripe `created`), falling back to when GymOS stored it. */
export function storedEventTime(e: StoredStripeEvent): Date {
  return unixDate(obj(e.payload)?.['created']) ?? e.createdAt;
}

/** Stripe event id of a stored event (payload.id). */
export function storedEventId(e: StoredStripeEvent): string | null {
  return str(obj(e.payload)?.['id']);
}

function sortedEvents(events: readonly StoredStripeEvent[]): StoredStripeEvent[] {
  return [...events].sort((a, b) => storedEventTime(a).getTime() - storedEventTime(b).getTime() || a.createdAt.getTime() - b.createdAt.getTime());
}

function subscriptionObject(e: StoredStripeEvent): Json | null {
  return obj(obj(obj(e.payload)?.['data'])?.['object']);
}

/**
 * Stripe's newest known view of one subscription from stored customer.subscription.* events.
 * A deletion is terminal: a later-delivered update in the same second cannot revive it.
 */
export function readStripeSubscriptionFacts(events: readonly StoredStripeEvent[], stripeSubscriptionId: string): StripeSubscriptionFacts | null {
  let latest: StripeSubscriptionFacts | null = null;
  let deleted = false;
  for (const e of sortedEvents(events)) {
    if (!e.eventType.startsWith('customer.subscription.')) continue;
    const sub = subscriptionObject(e);
    if (!sub || sub['id'] !== stripeSubscriptionId) continue;
    const isDeletion = e.eventType === 'customer.subscription.deleted';
    if (deleted && !isDeletion) continue;
    deleted = deleted || isDeletion;
    const details = obj(sub['cancellation_details']);
    latest = {
      status: str(sub['status']) ?? 'unknown',
      cancelAtPeriodEnd: sub['cancel_at_period_end'] === true,
      cancelAt: unixDate(sub['cancel_at']),
      canceledAt: unixDate(sub['canceled_at']),
      endedAt: unixDate(sub['ended_at']),
      cancellationReason: str(details?.['reason']),
      cancellationFeedback: str(details?.['feedback']),
      observedAt: storedEventTime(e),
    };
  }
  return latest;
}

export type RenewalFlip = { disabled: boolean; at: Date; requestId: string | null; idempotencyKey: string | null };

/** The newest stored change of cancel_at_period_end for one subscription (optionally up to `until`). */
export function readStripeRenewalFlip(events: readonly StoredStripeEvent[], stripeSubscriptionId: string, until?: Date): RenewalFlip | null {
  let flip: RenewalFlip | null = null;
  for (const e of sortedEvents(events)) {
    if (e.eventType !== 'customer.subscription.updated') continue;
    if (until && storedEventTime(e).getTime() > until.getTime()) continue;
    const payload = obj(e.payload);
    const data = obj(payload?.['data']);
    const sub = obj(data?.['object']);
    const previous = obj(data?.['previous_attributes']);
    if (!sub || sub['id'] !== stripeSubscriptionId || !previous || !('cancel_at_period_end' in previous)) continue;
    if (previous['cancel_at_period_end'] === sub['cancel_at_period_end']) continue;
    const request = obj(payload?.['request']);
    flip = {
      disabled: sub['cancel_at_period_end'] === true,
      at: storedEventTime(e),
      requestId: str(request?.['id']),
      idempotencyKey: str(request?.['idempotency_key']),
    };
  }
  return flip;
}

/** Cancellation-survey answer reported shortly after a renewal change (Stripe sends it separately). */
export function readCancellationFeedbackNear(events: readonly StoredStripeEvent[], stripeSubscriptionId: string, at: Date): string | null {
  const windowMs = 15 * 60_000;
  let feedback: string | null = null;
  for (const e of sortedEvents(events)) {
    if (!e.eventType.startsWith('customer.subscription.')) continue;
    const sub = subscriptionObject(e);
    if (!sub || sub['id'] !== stripeSubscriptionId) continue;
    const t = storedEventTime(e).getTime();
    if (t < at.getTime() || t - at.getTime() > windowMs) continue;
    feedback = str(obj(sub['cancellation_details'])?.['feedback']) ?? feedback;
  }
  return feedback;
}

/** Newest stored invoice.payment_failed facts for one invoice. */
export function readStoredInvoiceFailure(events: readonly StoredStripeEvent[], invoiceId: string): StoredInvoiceFailure | null {
  let latest: StoredInvoiceFailure | null = null;
  for (const e of sortedEvents(events)) {
    if (e.eventType !== 'invoice.payment_failed') continue;
    const invoice = subscriptionObject(e);
    if (!invoice || invoice['id'] !== invoiceId) continue;
    latest = {
      attemptCount: num(invoice['attempt_count']),
      nextAttemptAt: unixDate(invoice['next_payment_attempt']),
      invoiceStatus: str(invoice['status']),
      billingReason: str(invoice['billing_reason']),
      at: storedEventTime(e),
    };
  }
  return latest;
}

// ── Renewal change origin ─────────────────────────────────────────────────────

const GYMOS_KEY_PREFIX = 'gymos_';
const GYMOS_STRIPE_TO_CASH_KEY_PREFIX = 'gymos_stripe_to_cash_';
const GYMOS_RENEWAL_ACTIONS = ['STRIPE_RENEWAL_DISABLED', 'STRIPE_RENEWAL_REACTIVATED'];
const STRIPE_TO_CASH_ACTIONS = ['STRIPE_TO_CASH_PERIOD_END_SCHEDULED', 'STRIPE_TO_CASH_IMMEDIATE'];

export type RenewalAuditFact = {
  action: string;
  at: Date;
  actorName: string | null;
  metadata: Record<string, unknown>;
};

/**
 * Who switched auto-renewal on or off. Uses the stored Stripe event (request id and idempotency
 * key) when there is one, and the GymOS audit trail for the actor. A staff actor is only claimed
 * when a GymOS renewal audit row confirms it.
 */
export function resolveRenewalChange(input: {
  flip: RenewalFlip | null;
  feedback: string | null;
  audits: readonly RenewalAuditFact[];
}): RenewalChangeFact | null {
  const nearestAudit = (at: Date, actions: readonly string[]) =>
    input.audits
      .filter((a) => actions.includes(a.action) && Math.abs(a.at.getTime() - at.getTime()) <= 10 * 60_000)
      .sort((a, b) => Math.abs(a.at.getTime() - at.getTime()) - Math.abs(b.at.getTime() - at.getTime()))[0] ?? null;

  if (input.flip) {
    const { flip } = input;
    const key = flip.idempotencyKey ?? '';
    if (key.startsWith(GYMOS_STRIPE_TO_CASH_KEY_PREFIX)) {
      const audit = nearestAudit(flip.at, STRIPE_TO_CASH_ACTIONS);
      return { disabled: flip.disabled, at: flip.at, origin: 'STRIPE_TO_CASH', actorName: audit?.actorName ?? null, feedback: null, certainty: 'confirmed' };
    }
    if (key.startsWith(GYMOS_KEY_PREFIX)) {
      const audit = nearestAudit(flip.at, GYMOS_RENEWAL_ACTIONS);
      return audit
        ? { disabled: flip.disabled, at: flip.at, origin: 'GYMOS_STAFF', actorName: audit.actorName, feedback: null, certainty: 'confirmed' }
        : { disabled: flip.disabled, at: flip.at, origin: 'GYMOS', actorName: null, feedback: null, certainty: 'confirmed' };
    }
    if (flip.requestId) {
      return { disabled: flip.disabled, at: flip.at, origin: 'STRIPE_API', actorName: null, feedback: input.feedback, certainty: 'inferred' };
    }
    return {
      disabled: flip.disabled,
      at: flip.at,
      origin: input.feedback ? 'CUSTOMER_PORTAL' : 'STRIPE_NO_REQUEST',
      actorName: null,
      feedback: input.feedback,
      certainty: 'inferred',
    };
  }

  // No stored Stripe event (older rows): fall back to the newest GymOS audit row.
  const latest = [...input.audits].sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (!latest) return null;
  const newValue = latest.metadata['newCancelAtPeriodEnd'];
  const disabled = typeof newValue === 'boolean' ? newValue : latest.action !== 'STRIPE_RENEWAL_REACTIVATED';
  if (GYMOS_RENEWAL_ACTIONS.includes(latest.action)) {
    return { disabled, at: latest.at, origin: 'GYMOS_STAFF', actorName: latest.actorName, feedback: null, certainty: 'confirmed' };
  }
  if (STRIPE_TO_CASH_ACTIONS.includes(latest.action)) {
    return { disabled: true, at: latest.at, origin: 'STRIPE_TO_CASH', actorName: latest.actorName, feedback: null, certainty: 'confirmed' };
  }
  if (latest.action === 'STRIPE_RENEWAL_EXTERNAL_CHANGE') {
    const requestId = str(latest.metadata['stripeRequestId']);
    const feedback = str(latest.metadata['cancellationFeedback']) ?? input.feedback;
    return {
      disabled,
      at: latest.at,
      origin: requestId ? 'STRIPE_API' : feedback ? 'CUSTOMER_PORTAL' : 'STRIPE_NO_REQUEST',
      actorName: null,
      feedback,
      certainty: 'inferred',
    };
  }
  return null;
}

/** Origin of one renewal audit row, for the member timeline. */
export function renewalAuditOrigin(action: string, metadata: Record<string, unknown>, feedbackNear: string | null): RenewalChangeOrigin {
  if (GYMOS_RENEWAL_ACTIONS.includes(action)) return 'GYMOS_STAFF';
  if (STRIPE_TO_CASH_ACTIONS.includes(action)) return 'STRIPE_TO_CASH';
  if (action === 'STRIPE_RENEWAL_EXTERNAL_CHANGE') {
    if (str(metadata['stripeRequestId'])) return 'STRIPE_API';
    return str(metadata['cancellationFeedback']) ?? feedbackNear ? 'CUSTOMER_PORTAL' : 'STRIPE_NO_REQUEST';
  }
  return 'UNKNOWN';
}

// ── Subscription endings ──────────────────────────────────────────────────────

/** STRIPE_AUTOMATIC: Stripe ended it (non-payment, dispute, incomplete first payment). PERIOD_END: a scheduled end. */
export type SubscriptionEndOrigin = RenewalChangeOrigin | 'STRIPE_AUTOMATIC' | 'PERIOD_END';

export type StripeSubscriptionEnding = {
  stripeSubscriptionId: string;
  at: Date;
  /** cancellation_details.reason, or 'incomplete_expired' when the first payment never completed. */
  cancellationReason: string | null;
  feedback: string | null;
  origin: SubscriptionEndOrigin;
  /** For PERIOD_END: who had switched renewal off (or scheduled the cash change), when known. */
  scheduledBy: RenewalChangeOrigin | null;
};

/**
 * Every stored customer.subscription.deleted event, with why and by whom the subscription ended.
 * An end at period end is Stripe's automatic execution of an earlier decision: it is attributed
 * to whoever switched renewal off, not to the deletion event itself.
 */
export function readStripeSubscriptionEndings(
  events: readonly StoredStripeEvent[],
  auditsByStripeSubscription: ReadonlyMap<string, readonly RenewalAuditFact[]> = new Map(),
): StripeSubscriptionEnding[] {
  const endings: StripeSubscriptionEnding[] = [];
  for (const e of sortedEvents(events)) {
    if (e.eventType !== 'customer.subscription.deleted') continue;
    const payload = obj(e.payload);
    const sub = subscriptionObject(e);
    const id = str(sub?.['id']);
    if (!sub || !id) continue;
    const details = obj(sub['cancellation_details']);
    const status = str(sub['status']);
    const reason = status === 'incomplete_expired' ? 'incomplete_expired' : str(details?.['reason']);
    const feedback = str(details?.['feedback']);
    const request = obj(payload?.['request']);
    const key = str(request?.['idempotency_key']) ?? '';
    const requestId = str(request?.['id']);
    const canceledAt = unixDate(sub['canceled_at']);
    const endedAt = unixDate(sub['ended_at']);
    const cancelAt = unixDate(sub['cancel_at']);
    const at = endedAt ?? canceledAt ?? storedEventTime(e);

    let origin: SubscriptionEndOrigin;
    let scheduledBy: RenewalChangeOrigin | null = null;
    if (reason === 'payment_failed' || reason === 'payment_disputed' || reason === 'incomplete_expired') {
      origin = 'STRIPE_AUTOMATIC';
    } else if (key.startsWith(GYMOS_STRIPE_TO_CASH_KEY_PREFIX)) {
      origin = 'STRIPE_TO_CASH';
    } else if (key.startsWith(GYMOS_KEY_PREFIX)) {
      origin = 'GYMOS';
    } else if (requestId) {
      origin = 'STRIPE_API';
    } else {
      const scheduled =
        sub['cancel_at_period_end'] === true ||
        (cancelAt !== null && endedAt !== null && Math.abs(cancelAt.getTime() - endedAt.getTime()) <= 120_000) ||
        (canceledAt !== null && endedAt !== null && endedAt.getTime() - canceledAt.getTime() > 120_000);
      if (scheduled) {
        origin = 'PERIOD_END';
        const cutoff = canceledAt ?? endedAt ?? at;
        const flip = readStripeRenewalFlip(events, id, new Date(cutoff.getTime() + 60_000));
        const flipFeedback = flip?.disabled ? readCancellationFeedbackNear(events, id, flip.at) : null;
        const audits = (auditsByStripeSubscription.get(id) ?? []).filter((a) => a.at.getTime() <= at.getTime());
        const change = resolveRenewalChange({ flip: flip?.disabled ? flip : null, feedback: flipFeedback, audits: flip?.disabled ? audits : audits.filter((a) => a.action !== 'STRIPE_RENEWAL_REACTIVATED') });
        scheduledBy = change?.disabled ? change.origin : null;
      } else {
        origin = feedback ? 'CUSTOMER_PORTAL' : 'STRIPE_NO_REQUEST';
      }
    }
    endings.push({ stripeSubscriptionId: id, at, cancellationReason: reason, feedback, origin, scheduledBy });
  }
  return endings;
}

// ── Classification ────────────────────────────────────────────────────────────

const ENDED_STRIPE_STATUSES = new Set(['canceled', 'incomplete_expired']);
const ALIVE_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']);
const OVERDUE_STRIPE_STATUSES = new Set(['past_due', 'unpaid']);
const SUPERSEDED_END_REASONS = new Set(['SUPERSEDED_PAYMENT_METHOD', 'SUPERSEDED_RENEWAL', 'SUPERSEDED_PLAN_CHANGE']);

export function explainMembershipBilling(input: {
  local: LocalMembershipFacts;
  stripe: StripeSubscriptionFacts | null;
  renewalChange: RenewalChangeFact | null;
  /** Newest unresolved FAILED payment of this subscription, if any. */
  failure: FailedInvoiceFacts | null;
  now: Date;
}): MembershipBillingStatus {
  const { local, stripe, now } = input;
  const failure = input.failure ? buildPaymentFailureView(input.failure) : null;
  const effectiveEnd = iso(local.effectiveEnd);
  const renewalOff = local.cancelAtPeriodEnd || stripe?.cancelAtPeriodEnd === true || (stripe?.cancelAt ?? null) !== null;
  // A change that contradicts the current renewal state is stale (e.g. re-enabled without an audit).
  const change =
    input.renewalChange && input.renewalChange.disabled === renewalOff
      ? { ...input.renewalChange, at: input.renewalChange.at.toISOString() }
      : null;

  const result = (
    state: BillingStateCode,
    severity: BillingSeverity,
    certainty: BillingCertainty,
    renewal: Pick<MembershipBillingStatus['renewal'], 'mode' | 'endsAt' | 'nextChargeAt'>,
    action: BillingAction | null,
    extra: { paymentFailure?: PaymentFailureView | null; statusMismatch?: MembershipBillingStatus['statusMismatch'] } = {},
  ): MembershipBillingStatus => ({
    subscriptionId: local.subscriptionId,
    planName: local.planName,
    source: local.source,
    state,
    severity,
    certainty,
    isEntitled: local.isEntitled,
    lifecycleStatus: local.lifecycleStatus,
    effectiveEnd,
    renewal: { ...renewal, change: local.source === 'STRIPE' ? change : null },
    paymentFailure: extra.paymentFailure === undefined ? failure : extra.paymentFailure,
    stripe: stripe
      ? {
          status: stripe.status,
          cancellationReason: stripe.cancellationReason,
          canceledAt: iso(stripe.canceledAt),
          endedAt: iso(stripe.endedAt),
          cancelAt: iso(stripe.cancelAt),
          observedAt: stripe.observedAt.toISOString(),
        }
      : null,
    statusMismatch: extra.statusMismatch ?? null,
    action,
  });

  if (local.status === 'SCHEDULED' || local.lifecycleStatus === 'SCHEDULED') {
    return result('SCHEDULED', 'info', 'confirmed', { mode: local.source === 'STRIPE' ? 'AUTOMATIC' : 'MANUAL', endsAt: effectiveEnd, nextChargeAt: null }, null);
  }

  if (local.paidWithoutEntitlement) {
    return result('PAID_WITHOUT_ENTITLEMENT', 'critical', 'confirmed', { mode: 'NONE', endsAt: effectiveEnd, nextChargeAt: null }, 'RECONCILE');
  }

  // ── Cash / manual memberships: never charged automatically ──
  if (local.source !== 'STRIPE') {
    if (local.status === 'CANCELED' || local.lifecycleStatus === 'REPLACED') {
      const replaced = local.endReason !== null && SUPERSEDED_END_REASONS.has(local.endReason);
      return result(replaced ? 'REPLACED' : 'CANCELED', 'info', 'confirmed', { mode: 'ENDED', endsAt: effectiveEnd, nextChargeAt: null }, null);
    }
    if (local.status === 'PAUSED') return result('PAUSED', 'info', 'confirmed', { mode: 'MANUAL', endsAt: effectiveEnd, nextChargeAt: null }, null);
    if (local.isEntitled) return result('MANUAL_ACTIVE', 'ok', 'confirmed', { mode: 'MANUAL', endsAt: effectiveEnd, nextChargeAt: null }, null);
    if (local.effectiveEnd && local.effectiveEnd.getTime() <= now.getTime()) {
      return result('MANUAL_EXPIRED', 'warning', 'confirmed', { mode: 'MANUAL', endsAt: effectiveEnd, nextChargeAt: null }, 'RENEW_MANUALLY');
    }
    return result('UNKNOWN', 'info', 'inferred', { mode: 'MANUAL', endsAt: effectiveEnd, nextChargeAt: null }, null);
  }

  // ── Card (Stripe) memberships ──
  const replaced = local.endReason !== null && SUPERSEDED_END_REASONS.has(local.endReason);

  // Stripe already ended the subscription. GymOS may still show it alive (e.g. a late
  // invoice.payment_failed demoted a cancelled row before the 2026-10 fix).
  if (stripe && ENDED_STRIPE_STATUSES.has(stripe.status)) {
    const statusMismatch = local.status !== 'CANCELED' ? { local: local.status, stripe: stripe.status } : null;
    const endsAt = iso(stripe.endedAt ?? stripe.canceledAt) ?? effectiveEnd;
    const nonPayment = stripe.cancellationReason === 'payment_failed' || stripe.status === 'incomplete_expired';
    if (nonPayment) {
      return result('CANCELED_PAYMENT_FAILED', statusMismatch ? 'critical' : 'warning', 'confirmed', { mode: 'ENDED', endsAt, nextChargeAt: null }, statusMismatch ? 'RECONCILE' : 'REVIEW_BILLING', { statusMismatch });
    }
    if (replaced) {
      return result('REPLACED', statusMismatch ? 'critical' : 'info', 'confirmed', { mode: 'ENDED', endsAt, nextChargeAt: null }, statusMismatch ? 'RECONCILE' : null, { statusMismatch, paymentFailure: null });
    }
    return result('CANCELED', statusMismatch ? 'critical' : 'info', stripe.cancellationReason ? 'confirmed' : 'inferred', { mode: 'ENDED', endsAt, nextChargeAt: null }, statusMismatch ? 'RECONCILE' : null, { statusMismatch });
  }

  // GymOS ended or paused it locally (staff status change), but Stripe's newest known status is
  // still alive: Stripe may keep charging.
  if (stripe && (local.status === 'CANCELED' || local.status === 'PAUSED') && ALIVE_STRIPE_STATUSES.has(stripe.status)) {
    if (local.status === 'PAUSED' && stripe.status === 'paused') {
      return result('PAUSED', 'info', 'confirmed', { mode: 'NONE', endsAt: effectiveEnd, nextChargeAt: null }, null);
    }
    if (local.status === 'PAUSED' && stripe.status === 'incomplete') {
      return result('PAYMENT_PENDING', 'warning', 'confirmed', { mode: 'AUTOMATIC', endsAt: effectiveEnd, nextChargeAt: null }, 'REVIEW_BILLING');
    }
    return result('STATUS_MISMATCH', 'critical', 'inferred', { mode: renewalOff ? 'DISABLED' : 'AUTOMATIC', endsAt: iso(stripe.cancelAt) ?? effectiveEnd, nextChargeAt: null }, 'RECONCILE', { statusMismatch: { local: local.status, stripe: stripe.status } });
  }

  if (local.status === 'CANCELED') {
    if (replaced) {
      return result('REPLACED', 'info', 'confirmed', { mode: 'ENDED', endsAt: effectiveEnd, nextChargeAt: null }, null, { paymentFailure: null });
    }
    // Local row cancelled; without a stored Stripe event the reason is not known.
    return result('CANCELED', 'info', 'inferred', { mode: 'ENDED', endsAt: effectiveEnd, nextChargeAt: null }, null);
  }

  const endsAt = iso(stripe?.cancelAt ?? null) ?? effectiveEnd;

  if (failure) {
    const renewal = { mode: renewalOff ? ('DISABLED' as const) : ('AUTOMATIC' as const), endsAt, nextChargeAt: null };
    if (failure.invoiceStatus === 'paid') {
      return result('INVOICE_PAID_IN_STRIPE', 'critical', 'confirmed', renewal, 'RECONCILE');
    }
    if (failure.invoiceStatus === 'void' || failure.invoiceStatus === 'uncollectible') {
      // Closed invoice: no further collection. A warning, not an emergency.
      return result('PAYMENT_FAILED_FINAL', 'warning', 'confirmed', renewal, 'REVIEW_BILLING');
    }
    // The failed charge itself is a fact GymOS recorded; whether its reason is known is reported
    // separately by paymentFailure.reason / detailSource.
    if (failure.reason === 'AUTHENTICATION_REQUIRED') {
      return result('PAYMENT_ACTION_REQUIRED', 'critical', 'confirmed', renewal, 'COMPLETE_AUTHENTICATION');
    }
    if (failure.nextAttemptAt !== null) {
      return result('PAYMENT_FAILED_RETRYING', 'critical', 'confirmed', renewal, 'UPDATE_PAYMENT_METHOD');
    }
    if (failure.detailSource === 'local') {
      // Neither Stripe nor a stored payload says whether another attempt is coming.
      return result('PAYMENT_FAILED', 'critical', 'inferred', renewal, 'UPDATE_PAYMENT_METHOD');
    }
    return result('PAYMENT_FAILED_FINAL', 'critical', 'confirmed', renewal, 'UPDATE_PAYMENT_METHOD');
  }

  if (stripe && OVERDUE_STRIPE_STATUSES.has(stripe.status) && (local.status === 'ACTIVE' || local.status === 'TRIALING')) {
    // Stripe says the latest invoice is overdue, GymOS shows the membership current.
    return result('STATUS_MISMATCH', 'warning', 'inferred', { mode: renewalOff ? 'DISABLED' : 'AUTOMATIC', endsAt, nextChargeAt: null }, 'REVIEW_BILLING', { statusMismatch: { local: local.status, stripe: stripe.status } });
  }

  if (local.status === 'PAST_DUE') {
    // No failed attempt recorded: an open renewal invoice, or a fixed-term period whose payment
    // has not been confirmed yet.
    return result('PAYMENT_PENDING', 'warning', 'inferred', { mode: renewalOff ? 'DISABLED' : 'AUTOMATIC', endsAt, nextChargeAt: null }, 'REVIEW_BILLING');
  }

  if (local.status === 'PAUSED') {
    // No stored Stripe status to compare with.
    return result('PAUSED', 'warning', 'inferred', { mode: 'NONE', endsAt, nextChargeAt: null }, 'REVIEW_BILLING');
  }

  if (local.isEntitled) {
    if (renewalOff) {
      return result('RENEWAL_DISABLED', 'info', 'confirmed', { mode: 'DISABLED', endsAt, nextChargeAt: null }, null);
    }
    return result('AUTO_RENEW_OK', 'ok', 'confirmed', { mode: 'AUTOMATIC', endsAt: effectiveEnd, nextChargeAt: effectiveEnd }, null);
  }

  if (local.effectiveEnd && local.effectiveEnd.getTime() <= now.getTime()) {
    if (renewalOff) {
      return result('ENDED_NOT_RENEWED', 'info', 'confirmed', { mode: 'ENDED', endsAt: effectiveEnd, nextChargeAt: null }, null);
    }
    return result('EXPIRED_UNPAID', 'warning', 'inferred', { mode: 'AUTOMATIC', endsAt: effectiveEnd, nextChargeAt: null }, 'REVIEW_BILLING');
  }

  return result('UNKNOWN', 'info', 'inferred', { mode: renewalOff ? 'DISABLED' : 'AUTOMATIC', endsAt, nextChargeAt: null }, null);
}
