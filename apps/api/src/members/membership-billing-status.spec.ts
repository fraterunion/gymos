import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyPaymentFailure,
  explainMembershipBilling,
  readCancellationFeedbackNear,
  readStoredInvoiceFailure,
  readStripeRenewalFlip,
  readStripeSubscriptionEndings,
  readStripeSubscriptionFacts,
  renewalAuditOrigin,
  resolveRenewalChange,
  type FailedInvoiceFacts,
  type LiveInvoiceFailure,
  type LocalMembershipFacts,
  type RenewalAuditFact,
  type StoredStripeEvent,
  type StripeSubscriptionFacts,
} from './membership-billing-status';

/** Sanitized production payloads (see test/fixtures/stripe-webhooks/README.md). */
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/stripe-webhooks', `${name}.json`), 'utf8'));
}
function stored(name: string): StoredStripeEvent {
  const payload = fixture(name);
  return { eventType: payload['type'] as string, createdAt: new Date((payload['created'] as number) * 1000 + 500), payload };
}

const NOW = new Date('2026-10-08T12:00:00.000Z');
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function local(overrides: Partial<LocalMembershipFacts> = {}): LocalMembershipFacts {
  return {
    subscriptionId: 'sub_local_pro',
    planName: 'Pro',
    source: 'STRIPE',
    status: 'ACTIVE',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date('2026-10-26T15:01:45.000Z'),
    endReason: null,
    isEntitled: true,
    lifecycleStatus: 'ACTIVE',
    effectiveEnd: new Date('2026-10-26T15:01:45.000Z'),
    fixedTerm: false,
    paidWithoutEntitlement: false,
    ...overrides,
  };
}

function stripeFacts(overrides: Partial<StripeSubscriptionFacts> = {}): StripeSubscriptionFacts {
  return { status: 'active', cancelAtPeriodEnd: false, cancelAt: null, canceledAt: null, endedAt: null, cancellationReason: null, cancellationFeedback: null, observedAt: day('2026-10-05'), ...overrides };
}

function liveFailure(overrides: Partial<LiveInvoiceFailure> = {}): LiveInvoiceFailure {
  return {
    invoiceStatus: 'open',
    billingReason: 'subscription_cycle',
    attemptCount: 7,
    nextPaymentAttemptAt: new Date('2026-10-09T21:03:57.000Z'),
    amountRemaining: 60000,
    paymentIntentStatus: 'requires_payment_method',
    errorType: 'card_error',
    errorCode: 'card_declined',
    declineCode: 'do_not_honor',
    outcomeType: 'issuer_declined',
    outcomeReason: 'do_not_honor',
    lastAttemptAt: new Date('2026-10-08T06:03:56.000Z'),
    hasPaymentMethod: true,
    ...overrides,
  };
}

function failed(overrides: Partial<FailedInvoiceFacts> = {}): FailedInvoiceFacts {
  return {
    paymentId: 'pay_failed',
    invoiceId: 'in_pro_renewal',
    amountCents: 60000,
    currency: 'mxn',
    firstFailedAt: new Date('2026-09-26T16:03:50.386Z'),
    stored: { attemptCount: 7, nextAttemptAt: new Date('2026-10-09T21:03:57.000Z'), invoiceStatus: 'open', billingReason: 'subscription_cycle', at: new Date('2026-10-08T06:04:03.000Z') },
    live: liveFailure(),
    liveLookup: 'ok',
    ...overrides,
  };
}

const pastDue = (overrides: Partial<LocalMembershipFacts> = {}) => local({ status: 'PAST_DUE', isEntitled: false, lifecycleStatus: 'PAST_DUE', ...overrides });

/** A customer.subscription.updated payload that flips cancel_at_period_end, as Stripe sends it. */
function renewalFlipEvent(opts: { subId: string; created: number; disabled: boolean; requestId?: string | null; idempotencyKey?: string | null; feedback?: string | null; previousOnlyFeedback?: boolean; status?: string }): StoredStripeEvent {
  const payload = {
    id: `evt_${opts.subId}_${opts.created}`,
    type: 'customer.subscription.updated',
    created: opts.created,
    request: { id: opts.requestId ?? null, idempotency_key: opts.idempotencyKey ?? null },
    data: {
      object: {
        id: opts.subId,
        object: 'subscription',
        status: opts.status ?? 'past_due',
        cancel_at_period_end: opts.disabled,
        cancel_at: opts.disabled ? 1792940505 : null,
        canceled_at: opts.disabled ? opts.created - 1 : null,
        ended_at: null,
        cancellation_details: { reason: opts.disabled ? 'cancellation_requested' : null, feedback: opts.feedback ?? null, comment: null },
      },
      previous_attributes: opts.previousOnlyFeedback
        ? { cancellation_details: { feedback: null } }
        : { cancel_at_period_end: !opts.disabled, cancellation_details: { reason: null } },
    },
  };
  return { eventType: payload.type, createdAt: new Date(opts.created * 1000 + 900), payload };
}

/** customer.subscription.deleted as Stripe sends it when it ends a subscription. */
function deletedEvent(opts: { subId: string; endedAt: string; canceledAt: string; cancelAtPeriodEnd: boolean; reason: string | null; feedback?: string | null; requestId?: string | null; idempotencyKey?: string | null; status?: string }): StoredStripeEvent {
  const payload = {
    id: `evt_del_${opts.subId}`,
    type: 'customer.subscription.deleted',
    created: unix(opts.endedAt) + 2,
    request: { id: opts.requestId ?? null, idempotency_key: opts.idempotencyKey ?? null },
    data: {
      object: {
        id: opts.subId,
        object: 'subscription',
        status: opts.status ?? 'canceled',
        cancel_at_period_end: opts.cancelAtPeriodEnd,
        cancel_at: opts.cancelAtPeriodEnd ? unix(opts.endedAt) : null,
        canceled_at: unix(opts.canceledAt),
        ended_at: unix(opts.endedAt),
        cancellation_details: { reason: opts.reason, feedback: opts.feedback ?? null, comment: null },
      },
    },
  };
  return { eventType: payload.type, createdAt: new Date(new Date(opts.endedAt).getTime() + 3000), payload };
}

describe('classifyPaymentFailure — Stripe decline data to a canonical reason', () => {
  it.each([
    ['issuer do_not_honor (production: card renewal)', liveFailure(), 'CARD_DECLINED', 'do_not_honor'],
    ['insufficient funds (production)', liveFailure({ declineCode: 'insufficient_funds', outcomeReason: 'insufficient_funds' }), 'INSUFFICIENT_FUNDS', 'insufficient_funds'],
    ['expired card', liveFailure({ declineCode: null, errorCode: 'expired_card' }), 'EXPIRED_CARD', 'expired_card'],
    ['incorrect CVC', liveFailure({ declineCode: null, errorCode: 'incorrect_cvc' }), 'INCORRECT_CVC', 'incorrect_cvc'],
    ['authentication required decline', liveFailure({ declineCode: 'authentication_required' }), 'AUTHENTICATION_REQUIRED', 'authentication_required'],
    ['intent waiting for 3D Secure', liveFailure({ paymentIntentStatus: 'requires_action', errorType: null, errorCode: null, declineCode: null, outcomeType: null }), 'AUTHENTICATION_REQUIRED', null],
    ['Stripe Radar block (production: generic_decline + highest_risk_level)', liveFailure({ declineCode: 'generic_decline', outcomeType: 'blocked', outcomeReason: 'highest_risk_level' }), 'BLOCKED_BY_STRIPE', null],
    ['processing error', liveFailure({ declineCode: 'processing_error' }), 'PROCESSING_ERROR', 'processing_error'],
    ['card not supported', liveFailure({ declineCode: 'card_not_supported' }), 'CARD_NOT_SUPPORTED', 'card_not_supported'],
  ])('%s', (_label, live, reason, code) => {
    expect(classifyPaymentFailure(live)).toEqual({ reason, code });
  });

  it('withholds lost/stolen/fraud codes: staff see a generic decline and no raw code', () => {
    for (const declineCode of ['stolen_card', 'lost_card', 'pickup_card', 'fraudulent']) {
      expect(classifyPaymentFailure(liveFailure({ declineCode }))).toEqual({ reason: 'CARD_DECLINED', code: null });
    }
  });

  it('withholds them on the authentication path too (leftover decline code on a 3DS intent)', () => {
    expect(classifyPaymentFailure(liveFailure({ paymentIntentStatus: 'requires_action', declineCode: 'stolen_card' }))).toEqual({ reason: 'AUTHENTICATION_REQUIRED', code: null });
  });

  it('recognises a renewal that could not even be attempted for lack of a payment method', () => {
    const live = liveFailure({ errorType: null, errorCode: null, declineCode: null, outcomeType: null, outcomeReason: null, hasPaymentMethod: false });
    expect(classifyPaymentFailure(live)).toEqual({ reason: 'NO_PAYMENT_METHOD', code: null });
  });

  it('never invents a reason', () => {
    expect(classifyPaymentFailure(null)).toEqual({ reason: 'UNKNOWN', code: null });
    expect(classifyPaymentFailure(liveFailure({ errorType: null, errorCode: null, declineCode: null, outcomeType: null, hasPaymentMethod: true }))).toEqual({ reason: 'UNKNOWN', code: null });
  });
});

describe('stored webhook payload readers (real dahlia payloads)', () => {
  it('reads Stripe cancelling a subscription for non-payment', () => {
    const facts = readStripeSubscriptionFacts([stored('dahlia-subscription-deleted-payment-failed')], 'sub_fx0026');
    expect(facts).toMatchObject({ status: 'canceled', cancellationReason: 'payment_failed', cancelAtPeriodEnd: false });
    expect(facts?.endedAt?.toISOString()).toBe(new Date(1790561641 * 1000).toISOString());
  });

  it('a deletion is terminal: an update delivered after it in the same second does not revive the subscription', () => {
    const deleted = stored('dahlia-subscription-deleted-payment-failed');
    const created = (deleted.payload as { created: number }).created;
    const lateUpdate = renewalFlipEvent({ subId: 'sub_fx0026', created, disabled: false, status: 'past_due' });
    expect(readStripeSubscriptionFacts([deleted, lateUpdate], 'sub_fx0026')?.status).toBe('canceled');
  });

  it('reads attempt count, retry, status and billing reason from the stored invoice.payment_failed', () => {
    expect(readStoredInvoiceFailure([stored('dahlia-invoice-payment-failed-after-delete')], 'in_fx0032')).toMatchObject({ attemptCount: 9, nextAttemptAt: null, invoiceStatus: 'open', billingReason: 'subscription_cycle' });
    expect(readStoredInvoiceFailure([stored('dahlia-invoice-payment-failed-after-delete')], 'in_other')).toBeNull();
  });

  it('ignores updates that did not change cancel_at_period_end', () => {
    expect(readStripeRenewalFlip([stored('dahlia-subscription-updated-booty-renewal')], 'sub_fx_booty_member')).toBeNull();
  });

  it('finds the renewal switch-off and the survey answer Stripe sends one second later', () => {
    const events = [
      renewalFlipEvent({ subId: 'sub_pro', created: 1790547279, disabled: true }),
      renewalFlipEvent({ subId: 'sub_pro', created: 1790547280, disabled: true, feedback: 'unused', previousOnlyFeedback: true }),
    ];
    const flip = readStripeRenewalFlip(events, 'sub_pro');
    expect(flip).toEqual({ disabled: true, at: new Date(1790547279 * 1000), requestId: null, idempotencyKey: null });
    expect(readCancellationFeedbackNear(events, 'sub_pro', flip!.at)).toBe('unused');
  });

  it('orders by Stripe event time, not by delivery order, and can stop at a cutoff', () => {
    const late = renewalFlipEvent({ subId: 'sub_x', created: 1000, disabled: true });
    const early = renewalFlipEvent({ subId: 'sub_x', created: 2000, disabled: false });
    expect(readStripeRenewalFlip([early, late], 'sub_x')?.disabled).toBe(false);
    expect(readStripeRenewalFlip([early, late], 'sub_x', new Date(1500 * 1000))?.disabled).toBe(true);
  });
});

describe('resolveRenewalChange — who switched auto-renewal off', () => {
  const at = new Date('2026-09-27T22:14:39.000Z');

  it('customer portal: no API request and a survey answer', () => {
    expect(resolveRenewalChange({ flip: { disabled: true, at, requestId: null, idempotencyKey: null }, feedback: 'unused', audits: [] }))
      .toEqual({ disabled: true, at, origin: 'CUSTOMER_PORTAL', actorName: null, feedback: 'unused', certainty: 'inferred' });
  });

  it('outside GymOS without a request and without survey answer stays unattributed', () => {
    expect(resolveRenewalChange({ flip: { disabled: true, at, requestId: null, idempotencyKey: null }, feedback: null, audits: [] })?.origin).toBe('STRIPE_NO_REQUEST');
  });

  it('Stripe Dashboard or another integration: an API request without a GymOS key', () => {
    expect(resolveRenewalChange({ flip: { disabled: true, at, requestId: 'req_123', idempotencyKey: 'abc' }, feedback: null, audits: [] })?.origin).toBe('STRIPE_API');
  });

  it('GymOS staff only when a GymOS renewal audit names the actor; a GymOS key alone is just "GymOS"', () => {
    const flip = { disabled: true, at, requestId: 'req_1', idempotencyKey: 'gymos_renewal_abc' };
    const audit: RenewalAuditFact = { action: 'STRIPE_RENEWAL_DISABLED', at: new Date(at.getTime() + 2000), actorName: 'Ana López · ADMIN', metadata: {} };
    expect(resolveRenewalChange({ flip, feedback: null, audits: [audit] })).toMatchObject({ origin: 'GYMOS_STAFF', actorName: 'Ana López · ADMIN', certainty: 'confirmed' });
    expect(resolveRenewalChange({ flip, feedback: null, audits: [] })).toMatchObject({ origin: 'GYMOS', actorName: null, certainty: 'confirmed' });
  });

  it('GymOS Stripe→cash change', () => {
    expect(resolveRenewalChange({ flip: { disabled: true, at, requestId: 'req_2', idempotencyKey: 'gymos_stripe_to_cash_sub_1_cancel_immediate' }, feedback: null, audits: [] })?.origin).toBe('STRIPE_TO_CASH');
  });

  it('falls back to the audit trail when no Stripe event is stored', () => {
    const change = resolveRenewalChange({
      flip: null,
      feedback: null,
      audits: [{ action: 'STRIPE_RENEWAL_EXTERNAL_CHANGE', at, actorName: null, metadata: { stripeRequestId: null, newCancelAtPeriodEnd: true, cancellationFeedback: null } }],
    });
    expect(change).toMatchObject({ disabled: true, origin: 'STRIPE_NO_REQUEST', certainty: 'inferred' });
    expect(resolveRenewalChange({ flip: null, feedback: null, audits: [] })).toBeNull();
  });

  it('attributes each renewal audit row for the timeline', () => {
    expect(renewalAuditOrigin('STRIPE_RENEWAL_DISABLED', {}, null)).toBe('GYMOS_STAFF');
    expect(renewalAuditOrigin('STRIPE_TO_CASH_IMMEDIATE', {}, null)).toBe('STRIPE_TO_CASH');
    expect(renewalAuditOrigin('STRIPE_RENEWAL_EXTERNAL_CHANGE', { stripeRequestId: null, cancellationFeedback: null }, 'unused')).toBe('CUSTOMER_PORTAL');
    expect(renewalAuditOrigin('STRIPE_RENEWAL_EXTERNAL_CHANGE', { stripeRequestId: null, cancellationFeedback: null }, null)).toBe('STRIPE_NO_REQUEST');
    expect(renewalAuditOrigin('STRIPE_RENEWAL_EXTERNAL_CHANGE', { stripeRequestId: 'req_9' }, null)).toBe('STRIPE_API');
  });
});

describe('readStripeSubscriptionEndings — why and by whom a subscription ended', () => {
  it('Stripe cancelling for non-payment is automatic (real payload)', () => {
    expect(readStripeSubscriptionEndings([stored('dahlia-subscription-deleted-payment-failed')])).toEqual([
      { stripeSubscriptionId: 'sub_fx0026', at: new Date(1790561641 * 1000), cancellationReason: 'payment_failed', feedback: null, origin: 'STRIPE_AUTOMATIC', scheduledBy: null },
    ]);
  });

  it('an end of period is attributed to whoever switched renewal off: GymOS staff', () => {
    const subId = 'sub_period_end';
    const flip = renewalFlipEvent({ subId, created: unix('2026-09-01T10:00:00Z'), disabled: true, requestId: 'req_g', idempotencyKey: 'gymos_renewal_x', status: 'active' });
    const end = deletedEvent({ subId, endedAt: '2026-10-01T10:00:00Z', canceledAt: '2026-09-01T10:00:00Z', cancelAtPeriodEnd: true, reason: 'cancellation_requested' });
    const audits = new Map([[subId, [{ action: 'STRIPE_RENEWAL_DISABLED', at: new Date('2026-09-01T10:00:02Z'), actorName: 'Ana López · ADMIN', metadata: {} } as RenewalAuditFact]]]);
    expect(readStripeSubscriptionEndings([flip, end], audits)[0]).toMatchObject({ origin: 'PERIOD_END', scheduledBy: 'GYMOS_STAFF', at: new Date('2026-10-01T10:00:00Z') });
  });

  it('an end of period after the customer switched renewal off in the portal (old survey answer still on the object)', () => {
    const subId = 'sub_portal_end';
    const flip = renewalFlipEvent({ subId, created: unix('2026-10-02T18:30:23Z'), disabled: true, status: 'active' });
    const survey = renewalFlipEvent({ subId, created: unix('2026-10-02T18:30:24Z'), disabled: true, feedback: 'unused', previousOnlyFeedback: true, status: 'active' });
    const end = deletedEvent({ subId, endedAt: '2026-11-16T17:24:56Z', canceledAt: '2026-10-02T18:30:23Z', cancelAtPeriodEnd: true, reason: 'cancellation_requested', feedback: 'unused' });
    expect(readStripeSubscriptionEndings([flip, survey, end])[0]).toMatchObject({ origin: 'PERIOD_END', scheduledBy: 'CUSTOMER_PORTAL', feedback: 'unused' });
  });

  it('an end of period scheduled by a Stripe→cash change', () => {
    const subId = 'sub_cash_end';
    const flip = renewalFlipEvent({ subId, created: unix('2026-09-20T10:00:00Z'), disabled: true, requestId: 'req_c', idempotencyKey: 'gymos_stripe_to_cash_sub_cash_end_cancel_at_period_end', status: 'active' });
    const end = deletedEvent({ subId, endedAt: '2026-10-01T10:00:00Z', canceledAt: '2026-09-20T10:00:00Z', cancelAtPeriodEnd: true, reason: 'cancellation_requested' });
    expect(readStripeSubscriptionEndings([flip, end])[0]).toMatchObject({ origin: 'PERIOD_END', scheduledBy: 'STRIPE_TO_CASH' });
  });

  it('immediate cancellations: GymOS payment-method change, Dashboard/API, portal, dispute, incomplete first payment', () => {
    const at = '2026-10-01T14:39:40Z';
    const make = (o: Partial<Parameters<typeof deletedEvent>[0]>) => readStripeSubscriptionEndings([deletedEvent({ subId: 's', endedAt: at, canceledAt: at, cancelAtPeriodEnd: false, reason: 'cancellation_requested', ...o })])[0];
    expect(make({ requestId: 'req_1', idempotencyKey: 'gymos_stripe_to_cash_s_cancel_immediate' }).origin).toBe('STRIPE_TO_CASH');
    expect(make({ requestId: 'req_2', idempotencyKey: 'dash' }).origin).toBe('STRIPE_API');
    expect(make({ feedback: 'too_expensive' }).origin).toBe('CUSTOMER_PORTAL');
    expect(make({}).origin).toBe('STRIPE_NO_REQUEST');
    expect(make({ reason: 'payment_disputed' })).toMatchObject({ origin: 'STRIPE_AUTOMATIC', cancellationReason: 'payment_disputed' });
    expect(make({ reason: null, status: 'incomplete_expired' })).toMatchObject({ origin: 'STRIPE_AUTOMATIC', cancellationReason: 'incomplete_expired' });
  });
});

describe('explainMembershipBilling — canonical state per membership', () => {
  it('1. one active card membership that renews automatically', () => {
    const r = explainMembershipBilling({ local: local(), stripe: null, renewalChange: null, failure: null, now: NOW });
    expect(r).toMatchObject({ state: 'AUTO_RENEW_OK', severity: 'ok', action: null, renewal: { mode: 'AUTOMATIC', nextChargeAt: '2026-10-26T15:01:45.000Z' } });
  });

  it('4. cancel_at_period_end: still active, will not be charged again, origin explained (production: renewal off in the portal)', () => {
    const change = { disabled: true, at: new Date('2026-10-02T18:30:23.000Z'), origin: 'CUSTOMER_PORTAL' as const, actorName: null, feedback: 'unused', certainty: 'inferred' as const };
    const r = explainMembershipBilling({
      local: local({ planName: 'Booty Lab by Etzia', cancelAtPeriodEnd: true, lifecycleStatus: 'ENDING', fixedTerm: true, effectiveEnd: new Date('2026-11-16T17:24:56.000Z') }),
      stripe: stripeFacts({ cancelAtPeriodEnd: true, cancelAt: new Date('2026-11-16T17:24:56.000Z'), canceledAt: new Date('2026-10-02T18:30:23.000Z'), cancellationReason: 'cancellation_requested', cancellationFeedback: 'unused' }),
      renewalChange: change,
      failure: null,
      now: NOW,
    });
    expect(r).toMatchObject({ state: 'RENEWAL_DISABLED', severity: 'info', action: null, effectiveEnd: '2026-11-16T17:24:56.000Z', renewal: { mode: 'DISABLED', endsAt: '2026-11-16T17:24:56.000Z', nextChargeAt: null, change: { origin: 'CUSTOMER_PORTAL', feedback: 'unused' } } });
  });

  it('5. failed renewal, card declined, Stripe retrying, renewal later switched off (production case)', () => {
    const r = explainMembershipBilling({
      local: pastDue({ cancelAtPeriodEnd: true }),
      stripe: stripeFacts({ status: 'past_due', cancelAtPeriodEnd: true, cancelAt: new Date('2026-10-26T15:01:45.000Z'), canceledAt: new Date('2026-09-27T22:14:38.000Z'), cancellationReason: 'cancellation_requested', cancellationFeedback: 'unused' }),
      renewalChange: { disabled: true, at: new Date('2026-09-27T22:14:39.000Z'), origin: 'CUSTOMER_PORTAL', actorName: null, feedback: 'unused', certainty: 'inferred' },
      failure: failed(),
      now: NOW,
    });
    expect(r).toMatchObject({
      state: 'PAYMENT_FAILED_RETRYING',
      severity: 'critical',
      certainty: 'confirmed',
      action: 'UPDATE_PAYMENT_METHOD',
      isEntitled: false,
      renewal: { mode: 'DISABLED', endsAt: '2026-10-26T15:01:45.000Z' },
      paymentFailure: { reason: 'CARD_DECLINED', code: 'do_not_honor', attemptCount: 7, nextAttemptAt: '2026-10-09T21:03:57.000Z', firstFailedAt: '2026-09-26T16:03:50.386Z', billingReason: 'subscription_cycle', detailSource: 'stripe_live' },
      statusMismatch: null,
    });
  });

  it('5b. the decline reason is "unknown", never guessed, when Stripe cannot be reached', () => {
    const r = explainMembershipBilling({ local: pastDue(), stripe: null, renewalChange: null, failure: failed({ live: null, liveLookup: 'unavailable' }), now: NOW });
    expect(r).toMatchObject({ state: 'PAYMENT_FAILED_RETRYING', paymentFailure: { reason: 'UNKNOWN', code: null, attemptCount: 7, detailSource: 'webhook_history', liveLookup: 'unavailable' } });
  });

  it('a retry whose time has passed is still a scheduled retry, not "no more retries"', () => {
    const r = explainMembershipBilling({ local: pastDue(), stripe: null, renewalChange: null, failure: failed({ live: liveFailure({ nextPaymentAttemptAt: new Date('2026-10-08T11:50:00.000Z') }) }), now: NOW });
    expect(r.state).toBe('PAYMENT_FAILED_RETRYING');
  });

  it('with no Stripe data at all the retry schedule is unknown, not final', () => {
    const r = explainMembershipBilling({ local: pastDue(), stripe: null, renewalChange: null, failure: failed({ live: null, stored: null, liveLookup: 'unavailable' }), now: NOW });
    expect(r).toMatchObject({ state: 'PAYMENT_FAILED', certainty: 'inferred', action: 'UPDATE_PAYMENT_METHOD', paymentFailure: { detailSource: 'local', nextAttemptAt: null } });
  });

  it('authentication required asks for confirmation, not a new card — unless the invoice is already closed', () => {
    const auth = liveFailure({ paymentIntentStatus: 'requires_action', declineCode: null, errorCode: null, errorType: null, outcomeType: null });
    expect(explainMembershipBilling({ local: pastDue(), stripe: null, renewalChange: null, failure: failed({ live: auth }), now: NOW }))
      .toMatchObject({ state: 'PAYMENT_ACTION_REQUIRED', action: 'COMPLETE_AUTHENTICATION', paymentFailure: { reason: 'AUTHENTICATION_REQUIRED' } });
    expect(explainMembershipBilling({ local: pastDue(), stripe: null, renewalChange: null, failure: failed({ live: { ...auth, invoiceStatus: 'void', nextPaymentAttemptAt: null } }), now: NOW }))
      .toMatchObject({ state: 'PAYMENT_FAILED_FINAL', severity: 'warning', action: 'REVIEW_BILLING' });
  });

  it('6. pending payment: an open invoice without a failed attempt is pending, not failed', () => {
    const r = explainMembershipBilling({ local: pastDue({ fixedTerm: true }), stripe: null, renewalChange: null, failure: null, now: NOW });
    expect(r).toMatchObject({ state: 'PAYMENT_PENDING', severity: 'warning', certainty: 'inferred', action: 'REVIEW_BILLING', paymentFailure: null });
  });

  it('6b. Stripe says no further retry (still collectible) vs closed invoices', () => {
    const exhausted = explainMembershipBilling({ local: pastDue(), stripe: null, renewalChange: null, failure: failed({ live: liveFailure({ nextPaymentAttemptAt: null }) }), now: NOW });
    expect(exhausted).toMatchObject({ state: 'PAYMENT_FAILED_FINAL', severity: 'critical', action: 'UPDATE_PAYMENT_METHOD' });
    for (const invoiceStatus of ['uncollectible', 'void']) {
      const closed = explainMembershipBilling({ local: pastDue(), stripe: null, renewalChange: null, failure: failed({ live: liveFailure({ invoiceStatus, nextPaymentAttemptAt: null }) }), now: NOW });
      expect(closed).toMatchObject({ state: 'PAYMENT_FAILED_FINAL', severity: 'warning', action: 'REVIEW_BILLING', paymentFailure: { invoiceStatus } });
    }
  });

  it('flags an invoice GymOS shows as failed but Stripe already shows as paid', () => {
    const r = explainMembershipBilling({ local: pastDue(), stripe: null, renewalChange: null, failure: failed({ live: liveFailure({ invoiceStatus: 'paid', amountRemaining: 0 }) }), now: NOW });
    expect(r).toMatchObject({ state: 'INVOICE_PAID_IN_STRIPE', severity: 'critical', action: 'RECONCILE' });
  });

  it('7. expired manual membership needs a manual renewal; active manual is fine; renewal changes never attach to cash rows', () => {
    const cash = local({ subscriptionId: 'sub_local_booty', planName: 'Booty Lab by Etzia', source: 'CASH', cancelAtPeriodEnd: true });
    const change = { disabled: true, at: day('2026-10-01'), origin: 'STRIPE_TO_CASH' as const, actorName: null, feedback: null, certainty: 'confirmed' as const };
    expect(explainMembershipBilling({ local: { ...cash, isEntitled: false, lifecycleStatus: 'EXPIRED', effectiveEnd: new Date('2026-10-02T18:00:00.000Z') }, stripe: null, renewalChange: change, failure: null, now: NOW }))
      .toMatchObject({ state: 'MANUAL_EXPIRED', severity: 'warning', action: 'RENEW_MANUALLY', renewal: { mode: 'MANUAL', endsAt: '2026-10-02T18:00:00.000Z', change: null } });
    expect(explainMembershipBilling({ local: { ...cash, lifecycleStatus: 'ENDING' }, stripe: null, renewalChange: null, failure: null, now: NOW }))
      .toMatchObject({ state: 'MANUAL_ACTIVE', severity: 'ok', action: null, renewal: { mode: 'MANUAL' } });
    expect(explainMembershipBilling({ local: { ...cash, status: 'PAUSED', isEntitled: false, lifecycleStatus: 'PAUSED' }, stripe: null, renewalChange: null, failure: null, now: NOW }).state).toBe('PAUSED');
  });

  it('8. mixed states on one member are explained separately (production: card Pro failed + cash Booty Lab expired)', () => {
    const pro = explainMembershipBilling({ local: pastDue({ cancelAtPeriodEnd: true }), stripe: null, renewalChange: null, failure: failed(), now: NOW });
    const booty = explainMembershipBilling({ local: local({ subscriptionId: 'sub_local_booty', planName: 'Booty Lab by Etzia', source: 'CASH', cancelAtPeriodEnd: true, isEntitled: false, lifecycleStatus: 'EXPIRED', effectiveEnd: new Date('2026-10-02T18:00:00.000Z') }), stripe: null, renewalChange: null, failure: null, now: NOW });
    expect([pro.planName, pro.state, pro.action]).toEqual(['Pro', 'PAYMENT_FAILED_RETRYING', 'UPDATE_PAYMENT_METHOD']);
    expect([booty.planName, booty.state, booty.action, booty.paymentFailure]).toEqual(['Booty Lab by Etzia', 'MANUAL_EXPIRED', 'RENEW_MANUALLY', null]);
  });

  it('Stripe cancelled for non-payment while GymOS still says PAST_DUE (production race, real payloads)', () => {
    const events = [stored('dahlia-subscription-deleted-payment-failed'), stored('dahlia-invoice-payment-failed-after-delete')];
    const r = explainMembershipBilling({
      local: pastDue({ planName: 'Full Access', endReason: 'MEMBER_CANCELLED' }),
      stripe: readStripeSubscriptionFacts(events, 'sub_fx0026'),
      renewalChange: null,
      failure: failed({ invoiceId: 'in_fx0032', stored: readStoredInvoiceFailure(events, 'in_fx0032'), live: liveFailure({ declineCode: 'insufficient_funds', attemptCount: 9, nextPaymentAttemptAt: null }) }),
      now: NOW,
    });
    expect(r).toMatchObject({
      state: 'CANCELED_PAYMENT_FAILED',
      severity: 'critical',
      action: 'RECONCILE',
      statusMismatch: { local: 'PAST_DUE', stripe: 'canceled' },
      stripe: { status: 'canceled', cancellationReason: 'payment_failed' },
      paymentFailure: { reason: 'INSUFFICIENT_FUNDS', attemptCount: 9, nextAttemptAt: null },
    });
  });

  it('GymOS cancelled or paused locally while Stripe is still alive: flagged, never shown as a quiet cancellation', () => {
    for (const status of ['CANCELED', 'PAUSED']) {
      const r = explainMembershipBilling({ local: local({ status, isEntitled: false, lifecycleStatus: status }), stripe: stripeFacts({ status: 'active' }), renewalChange: null, failure: null, now: NOW });
      expect(r).toMatchObject({ state: 'STATUS_MISMATCH', severity: 'critical', certainty: 'inferred', action: 'RECONCILE', statusMismatch: { local: status, stripe: 'active' } });
    }
    expect(explainMembershipBilling({ local: local({ status: 'PAUSED', isEntitled: false, lifecycleStatus: 'PAUSED' }), stripe: stripeFacts({ status: 'paused' }), renewalChange: null, failure: null, now: NOW }).state).toBe('PAUSED');
  });

  it('GymOS shows the membership current while Stripe reports it past due', () => {
    expect(explainMembershipBilling({ local: local(), stripe: stripeFacts({ status: 'past_due' }), renewalChange: null, failure: null, now: NOW }))
      .toMatchObject({ state: 'STATUS_MISMATCH', severity: 'warning', action: 'REVIEW_BILLING', statusMismatch: { local: 'ACTIVE', stripe: 'past_due' } });
  });

  it('a card membership cancelled in Stripe but still within its paid window keeps the local access end', () => {
    const r = explainMembershipBilling({
      local: local({ status: 'CANCELED', lifecycleStatus: 'ENDING', fixedTerm: true, effectiveEnd: new Date('2026-11-16T17:24:56.000Z') }),
      stripe: stripeFacts({ status: 'canceled', canceledAt: day('2026-10-01'), endedAt: day('2026-10-01'), cancellationReason: 'cancellation_requested' }),
      renewalChange: null,
      failure: null,
      now: NOW,
    });
    expect(r).toMatchObject({ state: 'CANCELED', isEntitled: true, effectiveEnd: '2026-11-16T17:24:56.000Z', renewal: { mode: 'ENDED' } });
  });

  it('a dispute is a cancellation, not a failed renewal', () => {
    const r = explainMembershipBilling({ local: local({ status: 'CANCELED', isEntitled: false, lifecycleStatus: 'CANCELED' }), stripe: stripeFacts({ status: 'canceled', cancellationReason: 'payment_disputed', endedAt: day('2026-10-01') }), renewalChange: null, failure: null, now: NOW });
    expect(r).toMatchObject({ state: 'CANCELED', stripe: { cancellationReason: 'payment_disputed' } });
  });

  it('drops a renewal change that contradicts the current renewal state (re-enabled without an audit)', () => {
    const stale = { disabled: true, at: day('2026-09-01'), origin: 'GYMOS_STAFF' as const, actorName: 'X', feedback: null, certainty: 'confirmed' as const };
    expect(explainMembershipBilling({ local: local(), stripe: null, renewalChange: stale, failure: null, now: NOW }).renewal.change).toBeNull();
  });

  it('a membership replaced by a cash sale is not reported as a payment problem', () => {
    const r = explainMembershipBilling({
      local: local({ planName: 'Basic Access', status: 'CANCELED', isEntitled: false, lifecycleStatus: 'REPLACED', endReason: 'SUPERSEDED_PAYMENT_METHOD' }),
      stripe: stripeFacts({ status: 'canceled', canceledAt: day('2026-10-01'), endedAt: day('2026-10-01'), cancellationReason: 'cancellation_requested' }),
      renewalChange: null,
      failure: failed(),
      now: NOW,
    });
    expect(r).toMatchObject({ state: 'REPLACED', severity: 'info', action: null, paymentFailure: null, statusMismatch: null });
  });

  it('paid-without-entitlement keeps its own critical state', () => {
    expect(explainMembershipBilling({ local: local({ paidWithoutEntitlement: true, isEntitled: false, lifecycleStatus: 'EXPIRED' }), stripe: null, renewalChange: null, failure: null, now: NOW }))
      .toMatchObject({ state: 'PAID_WITHOUT_ENTITLEMENT', severity: 'critical', action: 'RECONCILE' });
  });

  it('card membership whose access ended: no renewal payment recorded vs renewal switched off', () => {
    const ended = local({ isEntitled: false, lifecycleStatus: 'EXPIRED', effectiveEnd: day('2026-10-01') });
    expect(explainMembershipBilling({ local: ended, stripe: null, renewalChange: null, failure: null, now: NOW })).toMatchObject({ state: 'EXPIRED_UNPAID', certainty: 'inferred', action: 'REVIEW_BILLING' });
    expect(explainMembershipBilling({ local: { ...ended, cancelAtPeriodEnd: true }, stripe: null, renewalChange: null, failure: null, now: NOW })).toMatchObject({ state: 'ENDED_NOT_RENEWED', action: null });
  });

  it('a cancellation scheduled with cancel_at (not cancel_at_period_end) still counts as renewal off', () => {
    const r = explainMembershipBilling({ local: local(), stripe: stripeFacts({ cancelAt: new Date('2026-10-20T00:00:00.000Z'), cancellationReason: 'cancellation_requested' }), renewalChange: null, failure: null, now: NOW });
    expect(r).toMatchObject({ state: 'RENEWAL_DISABLED', renewal: { endsAt: '2026-10-20T00:00:00.000Z' } });
  });

  it('scheduled successor', () => {
    expect(explainMembershipBilling({ local: local({ source: 'CASH', status: 'SCHEDULED', isEntitled: false, lifecycleStatus: 'SCHEDULED' }), stripe: null, renewalChange: null, failure: null, now: NOW }).state).toBe('SCHEDULED');
  });
});
