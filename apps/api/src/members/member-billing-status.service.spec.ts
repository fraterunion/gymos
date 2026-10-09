import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { InvoicePaymentFailureSnapshot, StripeService } from '../stripe/stripe.service';
import { MemberBillingStatusService } from './member-billing-status.service';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

type Row = Record<string, unknown>;

/** Example member: card Pro renewal declined, renewal later switched off; cash Booty Lab expired (synthetic ids and times). */
const PRO = {
  id: 'sub_local_pro',
  status: 'PAST_DUE',
  source: 'STRIPE',
  stripeSubscriptionId: 'sub_stripe_pro',
  cancelAtPeriodEnd: true,
  currentPeriodStart: new Date('2026-09-26T15:00:00.000Z'),
  currentPeriodEnd: new Date('2026-10-26T15:00:00.000Z'),
  entitlementEndsAt: null,
  endReason: null,
  createdAt: new Date('2026-08-26T15:00:00.000Z'),
  membershipPlan: { name: 'Pro', entitlementDays: null },
};
const BOOTY_CASH = {
  id: 'sub_local_booty',
  status: 'ACTIVE',
  source: 'CASH',
  stripeSubscriptionId: null,
  cancelAtPeriodEnd: true,
  currentPeriodStart: new Date('2026-08-18T18:00:00.000Z'),
  currentPeriodEnd: new Date('2026-09-19T05:00:00.000Z'),
  entitlementEndsAt: new Date('2026-10-02T18:00:00.000Z'),
  endReason: null,
  createdAt: new Date('2026-08-18T23:00:00.000Z'),
  membershipPlan: { name: 'Booty Lab by Etzia', entitlementDays: null },
};

function payment(overrides: Row): Row {
  return { id: 'pay', subscriptionId: PRO.id, status: 'SUCCEEDED', amountCents: 60000, currency: 'mxn', stripeInvoiceId: null, createdAt: NOW, paidAt: null, ...overrides };
}

function storedEvent(type: string, created: string, object: Row, previous: Row | null = null, request: Row = { id: null, idempotency_key: null }): Row {
  return {
    eventType: type,
    createdAt: new Date(new Date(created).getTime() + 2000),
    payload: { id: `evt_${type}_${created}`, type, created: unix(created), request, data: { object, ...(previous ? { previous_attributes: previous } : {}) } },
  };
}

const PRO_FLIP = storedEvent('customer.subscription.updated', '2026-09-27T22:00:01.000Z', { id: 'sub_stripe_pro', status: 'past_due', cancel_at_period_end: true, cancel_at: unix('2026-10-26T15:00:00.000Z'), canceled_at: unix('2026-09-27T22:00:00.000Z'), cancellation_details: { reason: 'cancellation_requested', feedback: null } }, { cancel_at_period_end: false, cancellation_details: { reason: null } });
const PRO_SURVEY = storedEvent('customer.subscription.updated', '2026-09-27T22:00:02.000Z', { id: 'sub_stripe_pro', status: 'past_due', cancel_at_period_end: true, cancel_at: unix('2026-10-26T15:00:00.000Z'), canceled_at: unix('2026-09-27T22:00:00.000Z'), cancellation_details: { reason: 'cancellation_requested', feedback: 'unused' } }, { cancellation_details: { feedback: null } });
const PRO_FAILED_EVENT = storedEvent('invoice.payment_failed', '2026-10-08T06:00:07.000Z', { id: 'in_pro_renewal', status: 'open', attempt_count: 7, next_payment_attempt: unix('2026-10-09T21:00:00.000Z'), billing_reason: 'subscription_cycle' });

const DECLINED: InvoicePaymentFailureSnapshot = {
  invoiceStatus: 'open',
  billingReason: 'subscription_cycle',
  attemptCount: 7,
  nextPaymentAttemptAt: new Date('2026-10-09T21:00:00.000Z'),
  amountRemaining: 60000,
  paymentIntentStatus: 'requires_payment_method',
  errorType: 'card_error',
  errorCode: 'card_declined',
  declineCode: 'do_not_honor',
  outcomeType: 'issuer_declined',
  outcomeReason: 'do_not_honor',
  lastAttemptAt: new Date('2026-10-08T06:00:00.000Z'),
  hasPaymentMethod: true,
};

type WebhookWhere = { eventType: string | { startsWith: string }; createdAt?: { gte: Date }; OR: Array<{ payload: { path: string[]; equals: string } }> };

/** Behaves like the Prisma query: type filter, JSON-path id filter, createdAt bound, newest first, take. */
function webhookTable(rows: Row[]) {
  return jest.fn(async ({ where, orderBy, take }: { where: WebhookWhere; orderBy: { createdAt: 'asc' | 'desc' }; take: number }) => {
    const ids = new Set(where.OR.map((o) => o.payload.equals));
    const matches = rows.filter((r) => {
      const type = r['eventType'] as string;
      const typeOk = typeof where.eventType === 'string' ? type === where.eventType : type.startsWith(where.eventType.startsWith);
      const objectId = ((r['payload'] as { data: { object: { id: string } } }).data.object.id);
      const sinceOk = !where.createdAt || (r['createdAt'] as Date).getTime() >= where.createdAt.gte.getTime();
      return typeOk && ids.has(objectId) && sinceOk;
    });
    const sorted = [...matches].sort((a, b) => ((a['createdAt'] as Date).getTime() - (b['createdAt'] as Date).getTime()) * (orderBy.createdAt === 'desc' ? -1 : 1));
    return sorted.slice(0, take);
  });
}

function build(opts: {
  member?: Row | null;
  subscriptions?: Row[];
  payments?: Row[];
  audits?: Row[];
  events?: Row[];
  snapshot?: (invoiceId: string) => Promise<InvoicePaymentFailureSnapshot>;
} = {}) {
  const webhookFindMany = webhookTable(opts.events ?? [PRO_FLIP, PRO_SURVEY, PRO_FAILED_EVENT]);
  const prisma = {
    studioMembership: { findFirst: jest.fn().mockResolvedValue(opts.member === undefined ? { id: 'sm_1' } : opts.member) },
    subscription: { findMany: jest.fn().mockResolvedValue(opts.subscriptions ?? [PRO, BOOTY_CASH]) },
    payment: {
      findMany: jest.fn().mockResolvedValue(
        opts.payments ?? [
          payment({ id: 'pay_failed', status: 'FAILED', stripeInvoiceId: 'in_pro_renewal', createdAt: new Date('2026-09-26T16:00:00.000Z') }),
          payment({ id: 'pay_first', stripeInvoiceId: 'in_pro_first', createdAt: new Date('2026-08-26T15:00:07.000Z'), paidAt: new Date('2026-08-26T15:00:01.000Z') }),
          payment({ id: 'pay_cash', subscriptionId: BOOTY_CASH.id, amountCents: 80000, createdAt: new Date('2026-08-18T23:00:02.000Z'), paidAt: new Date('2026-08-18T23:00:01.000Z') }),
        ],
      ),
    },
    auditLog: {
      findMany: jest.fn().mockResolvedValue(
        opts.audits ?? [
          { action: 'STRIPE_RENEWAL_EXTERNAL_CHANGE', createdAt: new Date('2026-09-27T22:00:04.000Z'), entityId: PRO.id, actor: null, metadata: { subscriptionId: PRO.id, stripeSubscriptionId: 'sub_stripe_pro', stripeRequestId: null, newCancelAtPeriodEnd: true, cancellationReason: 'cancellation_requested', cancellationFeedback: null } },
        ],
      ),
    },
    stripeWebhookEvent: { findMany: webhookFindMany },
    membershipPlan: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const getInvoicePaymentFailureSnapshot = jest.fn(opts.snapshot ?? (async () => DECLINED));
  const stripe = { getInvoicePaymentFailureSnapshot } as unknown as StripeService;
  const billingCases = { openCasesForMember: jest.fn().mockResolvedValue([]) };
  return { service: new MemberBillingStatusService(prisma, stripe, billingCases as never), prisma, getInvoicePaymentFailureSnapshot, webhookFindMany };
}

describe('MemberBillingStatusService', () => {
  it('explains each membership of a mixed member separately (card Pro failed + cash Booty Lab expired)', async () => {
    const { service, getInvoicePaymentFailureSnapshot } = build();
    const res = await service.getMemberBillingStatus('studio_1', 'user_1', NOW);

    expect(getInvoicePaymentFailureSnapshot).toHaveBeenCalledTimes(1);
    expect(getInvoicePaymentFailureSnapshot).toHaveBeenCalledWith('in_pro_renewal');
    expect(res.memberships.map((m) => [m.planName, m.state, m.action])).toEqual([
      ['Pro', 'PAYMENT_FAILED_RETRYING', 'UPDATE_PAYMENT_METHOD'],
      ['Booty Lab by Etzia', 'MANUAL_EXPIRED', 'RENEW_MANUALLY'],
    ]);
    expect(res.memberships[0]).toMatchObject({
      isEntitled: false,
      renewal: { mode: 'DISABLED', endsAt: '2026-10-26T15:00:00.000Z', change: { origin: 'CUSTOMER_PORTAL', feedback: 'unused', at: '2026-09-27T22:00:01.000Z' } },
      paymentFailure: { reason: 'CARD_DECLINED', code: 'do_not_honor', attemptCount: 7, nextAttemptAt: '2026-10-09T21:00:00.000Z', billingReason: 'subscription_cycle', detailSource: 'stripe_live' },
      stripe: { status: 'past_due', cancellationReason: 'cancellation_requested' },
    });
    expect(res.failedPayments).toEqual([expect.objectContaining({ paymentId: 'pay_failed', reason: 'CARD_DECLINED', liveLookup: 'ok' })]);
    expect(res).not.toHaveProperty('subscriptionEvents');
  });

  it('reads stored events only for the member\'s own Stripe objects, newest first, capped (no date bound: rows can be re-linked late)', async () => {
    const { service, webhookFindMany } = build();
    await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
    expect(webhookFindMany).toHaveBeenCalledWith({
      where: { eventType: { startsWith: 'customer.subscription.' }, OR: [{ payload: { path: ['data', 'object', 'id'], equals: 'sub_stripe_pro' } }] },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { eventType: true, createdAt: true, payload: true },
    });
    expect(webhookFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { eventType: 'invoice.payment_failed', OR: [{ payload: { path: ['data', 'object', 'id'], equals: 'in_pro_renewal' } }] },
    }));
  });

  it('caches the live Stripe lookup and shares one in-flight call between concurrent requests', async () => {
    let release: (v: InvoicePaymentFailureSnapshot) => void = () => undefined;
    const { service, getInvoicePaymentFailureSnapshot } = build({ snapshot: () => new Promise((resolve) => { release = resolve; }) });
    const a = service.getMemberBillingStatus('studio_1', 'user_1', NOW);
    const b = service.getMemberBillingStatus('studio_1', 'user_1', NOW);
    await new Promise((r) => setImmediate(r));
    release(DECLINED);
    await Promise.all([a, b]);
    await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
    expect(getInvoicePaymentFailureSnapshot).toHaveBeenCalledTimes(1);
  });

  it('scopes cached Stripe results by studio and member: another tenant never reuses an entry', async () => {
    const { service, getInvoicePaymentFailureSnapshot } = build();
    await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
    await service.getMemberBillingStatus('studio_2', 'user_2', NOW);
    await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
    expect(getInvoicePaymentFailureSnapshot).toHaveBeenCalledTimes(2);
  });

  it('degrades safely when Stripe rate-limits (429): reason unknown, stored attempts kept', async () => {
    const rateLimited = Object.assign(new Error('Too many requests hit the API too quickly.'), { type: 'StripeRateLimitError', statusCode: 429 });
    const { service } = build({ snapshot: async () => { throw rateLimited; } });
    const res = await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
    expect(res.memberships[0]).toMatchObject({ state: 'PAYMENT_FAILED_RETRYING', paymentFailure: { reason: 'UNKNOWN', liveLookup: 'unavailable', attemptCount: 7, detailSource: 'webhook_history' } });
  });

  it('reports "no reason given" when Stripe answers without a decline code', async () => {
    const { service } = build({ snapshot: async () => ({ ...DECLINED, errorType: null, errorCode: null, declineCode: null, outcomeType: null, outcomeReason: null }) });
    const res = await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
    expect(res.memberships[0].paymentFailure).toMatchObject({ reason: 'UNKNOWN', code: null, liveLookup: 'ok', detailSource: 'stripe_live' });
  });

  it('falls back to stored attempts and an "unknown" reason when Stripe errors', async () => {
    const { service } = build({ snapshot: async () => { throw new Error('Stripe down'); } });
    const res = await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
    expect(res.memberships[0]).toMatchObject({ state: 'PAYMENT_FAILED_RETRYING', paymentFailure: { reason: 'UNKNOWN', code: null, attemptCount: 7, detailSource: 'webhook_history', liveLookup: 'unavailable' } });
  });

  it('gives up on Stripe after the deadline instead of hanging the page', async () => {
    jest.useFakeTimers();
    try {
      const { service } = build({ snapshot: () => new Promise<never>(() => undefined) });
      const pending = service.getMemberBillingStatus('studio_1', 'user_1', NOW);
      await jest.advanceTimersByTimeAsync(4_001);
      const res = await pending;
      expect(res.memberships[0].paymentFailure).toMatchObject({ liveLookup: 'unavailable', reason: 'UNKNOWN' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not call Stripe when nothing failed (renewal switched off only)', async () => {
    const active = { ...PRO, status: 'ACTIVE', currentPeriodEnd: new Date('2026-11-16T17:24:56.000Z') };
    const asActive = (e: Row): Row => {
      const p = e['payload'] as { data: { object: Row } };
      return { ...e, payload: { ...p, data: { ...p.data, object: { ...p.data.object, status: 'active' } } } };
    };
    const { service, getInvoicePaymentFailureSnapshot } = build({ subscriptions: [active], events: [asActive(PRO_FLIP), asActive(PRO_SURVEY)], payments: [payment({ id: 'p1', stripeInvoiceId: 'in_ok', paidAt: NOW })] });
    const res = await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
    expect(getInvoicePaymentFailureSnapshot).not.toHaveBeenCalled();
    expect(res.memberships[0]).toMatchObject({ state: 'RENEWAL_DISABLED', paymentFailure: null, renewal: { change: { origin: 'CUSTOMER_PORTAL' } } });
    expect(res.failedPayments).toEqual([]);
  });

  describe('is a failure still current?', () => {
    const active = { ...PRO, status: 'ACTIVE', cancelAtPeriodEnd: false, currentPeriodEnd: new Date('2026-11-26T15:00:00.000Z') };
    const laterPaidOtherInvoice = payment({ id: 'p_paid_next', stripeInvoiceId: 'in_next', createdAt: new Date('2026-10-01T00:00:00.000Z'), paidAt: new Date('2026-10-01T00:00:00.000Z') });
    const oldFailure = payment({ id: 'p_old_fail', status: 'FAILED', stripeInvoiceId: 'in_pro_renewal', createdAt: new Date('2026-09-26T16:00:00.000Z') });

    it('yes, when Stripe still has its invoice open — even if a later invoice was paid', async () => {
      const { service } = build({ subscriptions: [active], audits: [], events: [PRO_FAILED_EVENT], payments: [laterPaidOtherInvoice, oldFailure] });
      const res = await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
      expect(res.memberships[0]).toMatchObject({ state: 'PAYMENT_FAILED_RETRYING', isEntitled: true, paymentFailure: { invoiceId: 'in_pro_renewal' } });
    });

    it('no, when Stripe voided that invoice', async () => {
      const { service } = build({ subscriptions: [active], audits: [], events: [], payments: [oldFailure], snapshot: async () => ({ ...DECLINED, invoiceStatus: 'void', nextPaymentAttemptAt: null }) });
      const res = await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
      expect(res.memberships[0]).toMatchObject({ state: 'AUTO_RENEW_OK', paymentFailure: null });
      expect(res.failedPayments).toEqual([expect.objectContaining({ paymentId: 'p_old_fail', invoiceStatus: 'void' })]);
    });

    it('without Stripe data, a later paid (or later refunded) payment puts the failure behind the member', async () => {
      for (const status of ['SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED']) {
        const { service } = build({ subscriptions: [active], audits: [], events: [], payments: [{ ...laterPaidOtherInvoice, status }, oldFailure], snapshot: async () => { throw new Error('down'); } });
        const res = await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
        expect(res.memberships[0]).toMatchObject({ state: 'AUTO_RENEW_OK', paymentFailure: null });
      }
    });
  });

  it('caps live lookups per request; older failures say they were not checked', async () => {
    const failures = Array.from({ length: 7 }, (_, i) =>
      payment({ id: `pf_${i}`, status: 'FAILED', stripeInvoiceId: `in_${i}`, createdAt: new Date(NOW.getTime() - (i + 1) * 86_400_000) }),
    );
    const { service, getInvoicePaymentFailureSnapshot } = build({ payments: failures });
    const res = await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
    expect(getInvoicePaymentFailureSnapshot).toHaveBeenCalledTimes(5);
    expect(res.failedPayments.map((f) => f.liveLookup)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'skipped', 'skipped']);
  });

  it('a Stripe→cash audit explains the card subscription it stopped, never the cash row it created', async () => {
    const card = { ...PRO, status: 'CANCELED', cancelAtPeriodEnd: false, endReason: 'SUPERSEDED_PAYMENT_METHOD' };
    const cash = { ...BOOTY_CASH, id: 'sub_cash_new', membershipPlan: { name: 'Pro', entitlementDays: null }, entitlementEndsAt: new Date('2026-11-01T00:00:00.000Z') };
    const { service } = build({
      subscriptions: [cash, card],
      payments: [],
      events: [],
      audits: [{ action: 'STRIPE_TO_CASH_IMMEDIATE', createdAt: new Date('2026-10-01T14:00:01.000Z'), entityId: 'sub_cash_new', actor: { firstName: 'Ana', lastName: 'López' }, metadata: { oldSubscriptionId: card.id, stripeSubscriptionId: 'sub_stripe_pro' } }],
    });
    const res = await service.getMemberBillingStatus('studio_1', 'user_1', NOW);
    const cashStatus = res.memberships.find((m) => m.subscriptionId === 'sub_cash_new');
    const cardStatus = res.memberships.find((m) => m.subscriptionId === card.id);
    expect(cashStatus).toMatchObject({ state: 'MANUAL_ACTIVE', renewal: { change: null } });
    expect(cardStatus).toMatchObject({ state: 'REPLACED' });
  });

  it('Stripe-side endings carry the failure behind a non-payment cancellation, and only that one', async () => {
    const deleted = storedEvent('customer.subscription.deleted', '2026-09-28T02:14:05.000Z', { id: 'sub_stripe_pro', status: 'canceled', cancel_at_period_end: false, cancel_at: null, canceled_at: unix('2026-09-28T02:14:01.000Z'), ended_at: unix('2026-09-28T02:14:01.000Z'), cancellation_details: { reason: 'payment_failed', feedback: null } });
    const { service } = build({ events: [deleted, PRO_FAILED_EVENT], audits: [] });
    const ctx = await service.loadBillingContext('studio_1', 'user_1', NOW);
    expect(ctx.subscriptionEndings).toEqual([
      expect.objectContaining({ subscriptionId: PRO.id, planName: 'Pro', origin: 'STRIPE_AUTOMATIC', cancellationReason: 'payment_failed', failure: expect.objectContaining({ paymentId: 'pay_failed' }) }),
    ]);
    expect(ctx.memberships[0]).toMatchObject({ state: 'CANCELED_PAYMENT_FAILED', statusMismatch: { local: 'PAST_DUE', stripe: 'canceled' } });
  });

  it('refuses members of another studio', async () => {
    const { service } = build({ member: null });
    await expect(service.getMemberBillingStatus('studio_1', 'user_x', NOW)).rejects.toBeInstanceOf(NotFoundException);
  });
});
