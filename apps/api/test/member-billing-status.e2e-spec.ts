import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { INestApplication } from '@nestjs/common';
import { BillingInterval, PaymentMethod, PaymentStatus, Prisma, Role, SubscriptionEndReason, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService, type InvoicePaymentFailureSnapshot } from '../src/stripe/stripe.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';

/**
 * Member 360 billing explanations over real HTTP and real Postgres: the staff-only
 * billing-status endpoint, the enriched timeline, and the guarantee that decline data never
 * reaches the member-facing profile. Stripe is mocked; stored webhook payloads are real rows.
 */

const DAY = 86_400_000;
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures/stripe-webhooks', `${name}.json`), 'utf8'));
}

function declined(overrides: Partial<InvoicePaymentFailureSnapshot> = {}): InvoicePaymentFailureSnapshot {
  return {
    invoiceStatus: 'open',
    billingReason: 'subscription_cycle',
    attemptCount: 7,
    nextPaymentAttemptAt: new Date(Date.now() + DAY),
    amountRemaining: 60000,
    paymentIntentStatus: 'requires_payment_method',
    errorType: 'card_error',
    errorCode: 'card_declined',
    declineCode: 'do_not_honor',
    outcomeType: 'issuer_declined',
    outcomeReason: 'do_not_honor',
    lastAttemptAt: new Date(Date.now() - DAY),
    hasPaymentMethod: true,
    ...overrides,
  };
}

async function login(app: INestApplication, email: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

describe('Member 360 billing explanations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: { getInvoicePaymentFailureSnapshot: jest.Mock };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stripe = app.get(StripeService) as unknown as { getInvoicePaymentFailureSnapshot: jest.Mock };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    stripe.getInvoicePaymentFailureSnapshot.mockReset();
    stripe.getInvoicePaymentFailureSnapshot.mockRejectedValue(new Error('no Stripe network in e2e'));
  });

  /** Example member: Pro charge declined + Booty Lab cash expired (synthetic data). */
  async function seed() {
    const now = Date.now();
    // Unique Stripe ids per test: the service caches live Stripe lookups per invoice.
    const tag = randomBytes(3).toString('hex');
    const stripeSubId = `sub_e2e_pro_${tag}`;
    const renewalInvoiceId = `in_e2e_pro_renewal_${tag}`;
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const member = await createUserWithPassword(prisma);
    const owner = await createUserWithPassword(prisma);
    const frontDesk = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    await createMembership(prisma, frontDesk.id, studio.id, Role.FRONT_DESK);

    const pro = await prisma.membershipPlan.create({ data: { studioId: studio.id, name: 'Pro', priceCents: 60000, currency: 'mxn', billingInterval: BillingInterval.MONTHLY, classCredits: 5, active: true } });
    const booty = await prisma.membershipPlan.create({ data: { studioId: studio.id, name: 'Booty Lab by Etzia', priceCents: 80000, currency: 'mxn', billingInterval: BillingInterval.MONTHLY, classCredits: 4, entitlementDays: 45, active: true } });

    const proSub = await prisma.subscription.create({
      data: { studioId: studio.id, userId: member.id, membershipPlanId: pro.id, status: SubscriptionStatus.PAST_DUE, source: SubscriptionSource.STRIPE, stripeSubscriptionId: stripeSubId, cancelAtPeriodEnd: true, currentPeriodStart: new Date(now - 12 * DAY), currentPeriodEnd: new Date(now + 18 * DAY) },
    });
    const bootySub = await prisma.subscription.create({
      data: { studioId: studio.id, userId: member.id, membershipPlanId: booty.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH, cancelAtPeriodEnd: true, currentPeriodStart: new Date(now - 51 * DAY), currentPeriodEnd: new Date(now - 19 * DAY), entitlementEndsAt: new Date(now - 6 * DAY) },
    });

    await prisma.payment.createMany({
      data: [
        { studioId: studio.id, userId: member.id, subscriptionId: proSub.id, membershipPlanId: pro.id, amountCents: 60000, currency: 'mxn', status: PaymentStatus.SUCCEEDED, paymentMethod: PaymentMethod.STRIPE, stripeInvoiceId: `in_e2e_pro_first_${tag}`, paidAt: new Date(now - 42 * DAY), createdAt: new Date(now - 42 * DAY) },
        { studioId: studio.id, userId: member.id, subscriptionId: proSub.id, membershipPlanId: pro.id, amountCents: 60000, currency: 'mxn', status: PaymentStatus.FAILED, paymentMethod: PaymentMethod.STRIPE, stripeInvoiceId: renewalInvoiceId, createdAt: new Date(now - 12 * DAY) },
        { studioId: studio.id, userId: member.id, subscriptionId: bootySub.id, membershipPlanId: booty.id, amountCents: 80000, currency: 'mxn', status: PaymentStatus.SUCCEEDED, paymentMethod: PaymentMethod.CASH, paidAt: new Date(now - 51 * DAY), createdAt: new Date(now - 51 * DAY) },
      ],
    });

    const flipAt = new Date(now - 11 * DAY);
    const subscriptionObject = (feedback: string | null) => ({
      id: stripeSubId, object: 'subscription', customer: 'cus_e2e_member', status: 'past_due', cancel_at_period_end: true,
      cancel_at: unix(new Date(now + 18 * DAY)), canceled_at: unix(flipAt), ended_at: null,
      cancellation_details: { reason: 'cancellation_requested', feedback, comment: null, feedback_option: null },
    });
    await prisma.stripeWebhookEvent.createMany({
      data: [
        { stripeEventId: `evt_e2e_flip_${tag}`, eventType: 'customer.subscription.updated', processed: true, createdAt: new Date(flipAt.getTime() + 2000), payload: { id: `evt_e2e_flip_${tag}`, type: 'customer.subscription.updated', created: unix(flipAt), request: { id: null, idempotency_key: null }, data: { object: subscriptionObject(null), previous_attributes: { cancel_at_period_end: false, cancellation_details: { reason: null } } } } as Prisma.InputJsonValue },
        { stripeEventId: `evt_e2e_feedback_${tag}`, eventType: 'customer.subscription.updated', processed: true, createdAt: new Date(flipAt.getTime() + 3000), payload: { id: `evt_e2e_feedback_${tag}`, type: 'customer.subscription.updated', created: unix(flipAt) + 1, request: { id: null, idempotency_key: null }, data: { object: subscriptionObject('unused'), previous_attributes: { cancellation_details: { feedback: null } } } } as Prisma.InputJsonValue },
        { stripeEventId: `evt_e2e_failed_${tag}`, eventType: 'invoice.payment_failed', processed: true, createdAt: new Date(now - DAY), payload: { id: `evt_e2e_failed_${tag}`, type: 'invoice.payment_failed', created: unix(new Date(now - DAY)), request: { id: null, idempotency_key: null }, data: { object: { id: renewalInvoiceId, object: 'invoice', status: 'open', attempt_count: 7, next_payment_attempt: unix(new Date(now + DAY)) } } } as Prisma.InputJsonValue },
      ],
    });
    await prisma.auditLog.create({
      data: { studioId: studio.id, action: 'STRIPE_RENEWAL_EXTERNAL_CHANGE', targetUserId: member.id, entityType: 'Subscription', entityId: proSub.id, createdAt: new Date(flipAt.getTime() + 4000), metadata: { origin: 'STRIPE_EXTERNAL', subscriptionId: proSub.id, stripeSubscriptionId: stripeSubId, stripeRequestId: null, previousCancelAtPeriodEnd: false, newCancelAtPeriodEnd: true, cancellationReason: 'cancellation_requested', cancellationFeedback: null } },
    });

    return {
      studio,
      member,
      memberToken: await login(app, member.email, member.password),
      ownerToken: await login(app, owner.email, owner.password),
      frontDeskToken: await login(app, frontDesk.email, frontDesk.password),
      proSub,
      bootySub,
      renewalInvoiceId,
    };
  }

  const billingStatus = (studioId: string, userId: string, token: string) =>
    request(app.getHttpServer()).get(`/api/v1/studios/${studioId}/members/${userId}/billing-status`).set('Authorization', `Bearer ${token}`);

  it('explains each membership separately with the real decline reason and who switched renewal off', async () => {
    const s = await seed();
    stripe.getInvoicePaymentFailureSnapshot.mockImplementation(async (invoiceId: string) => {
      expect(invoiceId).toBe(s.renewalInvoiceId);
      return declined();
    });

    const res = await billingStatus(s.studio.id, s.member.id, s.ownerToken).expect(200);
    const byPlan = Object.fromEntries((res.body.memberships as Array<{ planName: string }>).map((m) => [m.planName, m]));

    expect(byPlan['Pro']).toMatchObject({
      subscriptionId: s.proSub.id,
      state: 'PAYMENT_FAILED_RETRYING',
      severity: 'critical',
      action: 'UPDATE_PAYMENT_METHOD',
      isEntitled: false,
      renewal: { mode: 'DISABLED', change: { origin: 'CUSTOMER_PORTAL', feedback: 'unused', disabled: true } },
      paymentFailure: { reason: 'CARD_DECLINED', code: 'do_not_honor', attemptCount: 7, amountCents: 60000, currency: 'mxn', detailSource: 'stripe_live' },
      stripe: { status: 'past_due', cancellationReason: 'cancellation_requested' },
    });
    expect(byPlan['Booty Lab by Etzia']).toMatchObject({ subscriptionId: s.bootySub.id, source: 'CASH', state: 'MANUAL_EXPIRED', action: 'RENEW_MANUALLY', paymentFailure: null });
    expect(stripe.getInvoicePaymentFailureSnapshot).toHaveBeenCalledTimes(1);
  });

  it('degrades to stored facts and an explicit "unknown reason" when Stripe is unreachable', async () => {
    const s = await seed();
    const res = await billingStatus(s.studio.id, s.member.id, s.ownerToken).expect(200);
    const pro = (res.body.memberships as Array<{ planName: string }>).find((m) => m.planName === 'Pro');
    expect(pro).toMatchObject({ state: 'PAYMENT_FAILED_RETRYING', paymentFailure: { reason: 'UNKNOWN', code: null, attemptCount: 7, detailSource: 'webhook_history', liveLookup: 'unavailable' } });
  });

  it('is staff-only: front desk can read it, the member cannot', async () => {
    const s = await seed();
    await billingStatus(s.studio.id, s.member.id, s.frontDeskToken).expect(200);
    await billingStatus(s.studio.id, s.member.id, s.memberToken).expect(403);
  });

  it('enforces authentication, role and studio isolation (no diagnostics for instructors or other studios)', async () => {
    const s = await seed();
    stripe.getInvoicePaymentFailureSnapshot.mockResolvedValue(declined());

    // No token.
    await request(app.getHttpServer()).get(`/api/v1/studios/${s.studio.id}/members/${s.member.id}/billing-status`).expect(401);

    // Staff role without billing access in the same studio.
    const instructor = await createUserWithPassword(prisma);
    await createMembership(prisma, instructor.id, s.studio.id, Role.INSTRUCTOR);
    await billingStatus(s.studio.id, s.member.id, await login(app, instructor.email, instructor.password)).expect(403);

    // Owner of another studio: not a member of this one.
    const other = await createStudio(prisma);
    const otherOwner = await createUserWithPassword(prisma);
    await createMembership(prisma, otherOwner.id, other.id, Role.OWNER);
    const otherToken = await login(app, otherOwner.email, otherOwner.password);
    await billingStatus(s.studio.id, s.member.id, otherToken).expect(403);

    // Through their own studio they cannot reach a member of this studio, and Stripe is never asked.
    stripe.getInvoicePaymentFailureSnapshot.mockClear();
    await billingStatus(other.id, s.member.id, otherToken).expect(404);
    expect(stripe.getInvoicePaymentFailureSnapshot).not.toHaveBeenCalled();

    // The timeline carries the same diagnostics: members cannot read it either.
    await request(app.getHttpServer()).get(`/api/v1/studios/${s.studio.id}/members/${s.member.id}/timeline`).set('Authorization', `Bearer ${s.memberToken}`).expect(403);
  });

  it('writes nothing', async () => {
    const s = await seed();
    stripe.getInvoicePaymentFailureSnapshot.mockResolvedValue(declined());
    const snapshot = async () => ({
      subscriptions: await prisma.subscription.findMany({ orderBy: { id: 'asc' } }),
      payments: await prisma.payment.findMany({ orderBy: { id: 'asc' } }),
      audits: await prisma.auditLog.count(),
      events: await prisma.stripeWebhookEvent.findMany({ orderBy: { id: 'asc' }, select: { id: true, processed: true, attemptCount: true, resolvedAt: true } }),
    });
    const before = await snapshot();
    await billingStatus(s.studio.id, s.member.id, s.ownerToken).expect(200);
    await request(app.getHttpServer()).get(`/api/v1/studios/${s.studio.id}/members/${s.member.id}/timeline`).set('Authorization', `Bearer ${s.ownerToken}`).expect(200);
    expect(await snapshot()).toEqual(before);
  });

  it('timeline: a failed payment says what was charged, for which plan and why; the renewal change says who', async () => {
    const s = await seed();
    stripe.getInvoicePaymentFailureSnapshot.mockResolvedValue(declined());
    const res = await request(app.getHttpServer()).get(`/api/v1/studios/${s.studio.id}/members/${s.member.id}/timeline`).set('Authorization', `Bearer ${s.ownerToken}`).expect(200);
    const events = res.body as Array<{ type: string; description?: string; metadata?: Record<string, unknown> }>;

    const failedEvent = events.find((e) => e.type === 'PAYMENT_FAILED');
    expect(failedEvent).toMatchObject({ description: 'MXN 600.00 · Pro', metadata: { planName: 'Pro', subscriptionId: s.proSub.id, failure: { reason: 'CARD_DECLINED', code: 'do_not_honor', attemptCount: 7 } } });

    const renewalEvent = events.find((e) => e.type === 'STRIPE_RENEWAL_EXTERNAL_CHANGE');
    expect(renewalEvent).toMatchObject({ metadata: { planName: 'Pro', renewalOrigin: 'CUSTOMER_PORTAL', cancellationFeedback: 'unused', newCancelAtPeriodEnd: true } });
  });

  it('Stripe cancelled for non-payment while GymOS still says PAST_DUE: flagged and shown in the timeline (real payloads)', async () => {
    const s = await seed();
    const plan = await prisma.membershipPlan.create({ data: { studioId: s.studio.id, name: 'Full Access', priceCents: 150000, currency: 'mxn', billingInterval: BillingInterval.MONTHLY, active: true } });
    const lapsedMember = await createUserWithPassword(prisma);
    await createMembership(prisma, lapsedMember.id, s.studio.id, Role.MEMBER);
    const sub = await prisma.subscription.create({
      data: { studioId: s.studio.id, userId: lapsedMember.id, membershipPlanId: plan.id, status: SubscriptionStatus.PAST_DUE, source: SubscriptionSource.STRIPE, stripeSubscriptionId: 'sub_fx0026', endReason: SubscriptionEndReason.MEMBER_CANCELLED, currentPeriodStart: new Date(Date.now() - 24 * DAY), currentPeriodEnd: new Date(Date.now() + 6 * DAY) },
    });
    await prisma.payment.create({ data: { studioId: s.studio.id, userId: lapsedMember.id, subscriptionId: sub.id, membershipPlanId: plan.id, amountCents: 150000, currency: 'mxn', status: PaymentStatus.FAILED, paymentMethod: PaymentMethod.STRIPE, stripeInvoiceId: 'in_fx0032', createdAt: new Date(Date.now() - 24 * DAY) } });
    for (const [name, eventType] of [['dahlia-subscription-deleted-payment-failed', 'customer.subscription.deleted'], ['dahlia-invoice-payment-failed-after-delete', 'invoice.payment_failed']] as const) {
      const payload = fixture(name);
      await prisma.stripeWebhookEvent.create({ data: { stripeEventId: payload['id'] as string, eventType, processed: true, payload: payload as Prisma.InputJsonValue } });
    }
    stripe.getInvoicePaymentFailureSnapshot.mockResolvedValue(declined({ declineCode: 'insufficient_funds', outcomeReason: 'insufficient_funds', attemptCount: 9, nextPaymentAttemptAt: null }));

    const status = await billingStatus(s.studio.id, lapsedMember.id, s.ownerToken).expect(200);
    expect(status.body.memberships[0]).toMatchObject({
      planName: 'Full Access',
      state: 'CANCELED_PAYMENT_FAILED',
      severity: 'critical',
      action: 'RECONCILE',
      statusMismatch: { local: 'PAST_DUE', stripe: 'canceled' },
      paymentFailure: { reason: 'INSUFFICIENT_FUNDS', attemptCount: 9, nextAttemptAt: null },
    });

    const timeline = await request(app.getHttpServer()).get(`/api/v1/studios/${s.studio.id}/members/${lapsedMember.id}/timeline`).set('Authorization', `Bearer ${s.ownerToken}`).expect(200);
    const ended = (timeline.body as Array<{ type: string; metadata?: Record<string, unknown> }>).find((e) => e.type === 'STRIPE_SUBSCRIPTION_ENDED');
    expect(ended).toMatchObject({ metadata: { planName: 'Full Access', endOrigin: 'STRIPE_AUTOMATIC', cancellationReason: 'payment_failed', failure: { reason: 'INSUFFICIENT_FUNDS' } } });
  });

  it('a GymOS-only cancellation while Stripe still shows the subscription active is flagged, not shown as a quiet cancellation', async () => {
    const s = await seed();
    const tag = randomBytes(3).toString('hex');
    const plan = await prisma.membershipPlan.create({ data: { studioId: s.studio.id, name: 'Basic Access', priceCents: 100000, currency: 'mxn', billingInterval: BillingInterval.MONTHLY, active: true } });
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, s.studio.id, Role.MEMBER);
    await prisma.subscription.create({
      data: { studioId: s.studio.id, userId: member.id, membershipPlanId: plan.id, status: SubscriptionStatus.CANCELED, source: SubscriptionSource.STRIPE, stripeSubscriptionId: `sub_e2e_local_cancel_${tag}`, endReason: SubscriptionEndReason.MEMBER_CANCELLED, currentPeriodStart: new Date(Date.now() - 5 * DAY), currentPeriodEnd: new Date(Date.now() + 25 * DAY) },
    });
    await prisma.stripeWebhookEvent.create({
      data: { stripeEventId: `evt_e2e_active_${tag}`, eventType: 'customer.subscription.updated', processed: true, createdAt: new Date(Date.now() - 5 * DAY), payload: { id: `evt_e2e_active_${tag}`, type: 'customer.subscription.updated', created: unix(new Date(Date.now() - 5 * DAY)), request: { id: null, idempotency_key: null }, data: { object: { id: `sub_e2e_local_cancel_${tag}`, object: 'subscription', status: 'active', cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null, cancellation_details: { reason: null, feedback: null } } } } as Prisma.InputJsonValue },
    });

    const res = await billingStatus(s.studio.id, member.id, s.ownerToken).expect(200);
    expect(res.body.memberships[0]).toMatchObject({ planName: 'Basic Access', state: 'STATUS_MISMATCH', severity: 'critical', action: 'RECONCILE', statusMismatch: { local: 'CANCELED', stripe: 'active' } });
  });

  it('an end of period is attributed to the earlier GymOS renewal change, not to "outside GymOS"', async () => {
    const s = await seed();
    const tag = randomBytes(3).toString('hex');
    const stripeId = `sub_e2e_period_end_${tag}`;
    const plan = await prisma.membershipPlan.create({ data: { studioId: s.studio.id, name: 'Full Access', priceCents: 150000, currency: 'mxn', billingInterval: BillingInterval.MONTHLY, active: true } });
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, s.studio.id, Role.MEMBER);
    await prisma.subscription.create({
      data: { studioId: s.studio.id, userId: member.id, membershipPlanId: plan.id, status: SubscriptionStatus.CANCELED, source: SubscriptionSource.STRIPE, stripeSubscriptionId: stripeId, endReason: SubscriptionEndReason.MEMBER_CANCELLED, cancelAtPeriodEnd: true, currentPeriodStart: new Date(Date.now() - 32 * DAY), currentPeriodEnd: new Date(Date.now() - 2 * DAY) },
    });
    const flipAt = new Date(Date.now() - 20 * DAY);
    const endedAt = new Date(Date.now() - 2 * DAY);
    const sub = (extra: Record<string, unknown>) => ({ id: stripeId, object: 'subscription', cancel_at: unix(endedAt), canceled_at: unix(flipAt), cancellation_details: { reason: 'cancellation_requested', feedback: null }, ...extra });
    await prisma.stripeWebhookEvent.createMany({
      data: [
        { stripeEventId: `evt_e2e_gymos_flip_${tag}`, eventType: 'customer.subscription.updated', processed: true, createdAt: flipAt, payload: { id: `evt_e2e_gymos_flip_${tag}`, type: 'customer.subscription.updated', created: unix(flipAt), request: { id: 'req_gymos', idempotency_key: `gymos_renewal_${tag}` }, data: { object: sub({ status: 'active', cancel_at_period_end: true, ended_at: null }), previous_attributes: { cancel_at_period_end: false } } } as Prisma.InputJsonValue },
        { stripeEventId: `evt_e2e_end_${tag}`, eventType: 'customer.subscription.deleted', processed: true, createdAt: endedAt, payload: { id: `evt_e2e_end_${tag}`, type: 'customer.subscription.deleted', created: unix(endedAt), request: { id: null, idempotency_key: null }, data: { object: sub({ status: 'canceled', cancel_at_period_end: true, ended_at: unix(endedAt) }) } } as Prisma.InputJsonValue },
      ],
    });

    const timeline = await request(app.getHttpServer()).get(`/api/v1/studios/${s.studio.id}/members/${member.id}/timeline`).set('Authorization', `Bearer ${s.ownerToken}`).expect(200);
    const ended = (timeline.body as Array<{ type: string; metadata?: Record<string, unknown> }>).find((e) => e.type === 'STRIPE_SUBSCRIPTION_ENDED');
    expect(ended).toMatchObject({ metadata: { planName: 'Full Access', endOrigin: 'PERIOD_END', scheduledBy: 'GYMOS', failure: null } });
  });

  it('the member-facing profile (/members/me) carries no decline data', async () => {
    const s = await seed();
    stripe.getInvoicePaymentFailureSnapshot.mockResolvedValue(declined());
    const me = await request(app.getHttpServer()).get(`/api/v1/studios/${s.studio.id}/members/me`).set('Authorization', `Bearer ${s.memberToken}`).expect(200);
    const body = JSON.stringify(me.body);
    expect(body).not.toContain('do_not_honor');
    expect(body).not.toContain('paymentFailure');
    expect(body).not.toContain('CUSTOMER_PORTAL');
    expect(stripe.getInvoicePaymentFailureSnapshot).not.toHaveBeenCalled();
  });
});
