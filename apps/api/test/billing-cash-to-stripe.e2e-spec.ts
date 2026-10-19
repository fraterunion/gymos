import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingInterval, Role, SubscriptionEndReason, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import { BillingService } from '../src/billing/billing.service';
import { SubscriptionLifecycleService } from '../src/billing/subscription-lifecycle.service';
import { BookingAccessService } from '../src/bookings/booking-access.service';
import { MembershipUsageService } from '../src/membership-usage/membership-usage.service';
import { currentlyEntitledSubscriptionWhere } from '../src/memberships/membership-entitlement';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createClassTemplate, createMembership, createScheduledClass, createStudio, createUserWithPassword } from './helpers/factories';
import { fixture, rebind, signedPost, stripeMutationCalls, stripeSubscriptionLike, type StripeEvent } from './helpers/billing-reliability';

/**
 * INC-2026-10-19 regression, end to end on real Postgres: real partial unique indexes, real
 * member advisory lock, real signature verification. A member whose CASH membership lapsed (row
 * still ACTIVE: nothing expires offline rows) buys the same family online. Before the fix the
 * webhook inserted the Stripe row while the CASH row was still ACTIVE → P2002 → dead-lettered
 * subscription events, while invoice.paid recorded an unlinked SUCCEEDED Payment: paid, no access.
 * Stripe HTTP is mocked; all data is synthetic.
 */
describe('Billing — expired offline membership superseded by a Stripe purchase (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: Record<string, jest.Mock>;
  let secret: string;

  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stripe = app.get(StripeService) as unknown as Record<string, jest.Mock>;
    secret = app.get(ConfigService).getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
  });
  afterAll(async () => {
    await truncateAll(prisma);
    await app.close();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  const post = (e: StripeEvent) => signedPost(app, secret, e);

  async function world(opts: { cashPlan?: 'full' | 'basic'; cashEndsInMs?: number; cashEntitlementDays?: boolean } = {}) {
    const now = Date.now();
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const full = await prisma.membershipPlan.create({ data: { studioId: studio.id, name: 'Full Access', priceCents: 150000, currency: 'mxn', billingInterval: BillingInterval.MONTHLY, active: true, exclusiveGroup: 'CORE', allClassesAccess: true, openGymAccess: true, stripePriceId: 'price_fx_full', stripeProductId: 'prod_fx_full' } });
    const basic = await prisma.membershipPlan.create({ data: { studioId: studio.id, name: 'Basic Access', priceCents: 100000, currency: 'mxn', billingInterval: BillingInterval.MONTHLY, active: true, exclusiveGroup: 'CORE', allClassesAccess: true, stripePriceId: 'price_fx_basic', stripeProductId: 'prod_fx_basic' } });
    const settings = await prisma.studioEnrollmentSettings.create({ data: { studioId: studio.id, enrollmentFeeCents: 49900, campaignEnabled: true, campaignType: 'FIRST_N_MEMBERS', campaignLimit: 50 } });
    const owner = await createUserWithPassword(prisma);
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const member = await createUserWithPassword(prisma);
    const cus = 'cus_fx_cash_member';
    await prisma.user.update({ where: { id: member.id }, data: { stripeCustomerId: cus } });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const cashPlan = opts.cashPlan === 'basic' ? basic : full;
    const cashEnd = new Date(now + (opts.cashEndsInMs ?? -2 * DAY));
    const cash = await prisma.subscription.create({ data: { studioId: studio.id, userId: member.id, membershipPlanId: cashPlan.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH, exclusiveGroupKey: 'CORE', currentPeriodStart: new Date(cashEnd.getTime() - 30 * DAY), currentPeriodEnd: cashEnd, cancelAtPeriodEnd: true, createdByUserId: owner.id } });
    // A bystander with the same lapsed shape: must never be touched by this member's purchase.
    const bystander = await createUserWithPassword(prisma);
    await createMembership(prisma, bystander.id, studio.id, Role.MEMBER);
    const bystanderCash = await prisma.subscription.create({ data: { studioId: studio.id, userId: bystander.id, membershipPlanId: full.id, status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.CASH, exclusiveGroupKey: 'CORE', currentPeriodStart: new Date(now - 32 * DAY), currentPeriodEnd: new Date(now - 2 * DAY), cancelAtPeriodEnd: true } });

    const subId = 'sub_fx_online', invId = 'in_fx_online_first', csId = 'cs_fx_online';
    const pStart = Math.floor((now - HOUR) / 1000), pEnd = Math.floor((now - HOUR + 31 * DAY) / 1000);
    const md = { userId: member.id, studioId: studio.id, planId: full.id };
    const tokens = { sub_fx0026: subId, price_fx0027: 'price_fx_full', prod_fx0028: 'prod_fx_full', si_fx0029: 'si_fx_online', cus_fx0030: cus, sub_fx0008: subId, price_fx0010: 'price_fx_full', prod_fx0011: 'prod_fx_full', si_fx0009: 'si_fx_online', cus_fx0014: cus, in_fx0006: invId };
    let seq = 0;
    const created = (id = `evt_fx_online_created_${++seq}`): StripeEvent => {
      const e = rebind(fixture('dahlia-subscription-deleted-payment-failed'), tokens);
      const o = e.data.object;
      e.id = id;
      e.type = 'customer.subscription.created';
      Object.assign(o, { status: 'active', canceled_at: null, ended_at: null, cancel_at_period_end: false, metadata: md, latest_invoice: invId, cancellation_details: { reason: null, comment: null, feedback: null, feedback_option: null } });
      o.items.data[0].current_period_start = pStart;
      o.items.data[0].current_period_end = pEnd;
      e.data.previous_attributes = null;
      return e;
    };
    const paid = (id = `evt_fx_online_paid_${++seq}`): StripeEvent => {
      const e = rebind(fixture('dahlia-invoice-paid-monthly-renewal'), tokens);
      const o = e.data.object;
      e.id = id;
      Object.assign(o, { billing_reason: 'subscription_create', amount_paid: 150000, amount_due: 150000, total: 150000, subtotal: 150000 });
      o.parent.subscription_details.metadata = md;
      o.lines.data[0].amount = 150000;
      o.lines.data[0].metadata = md;
      o.lines.data[0].period = { start: pStart, end: pEnd };
      o.status_transitions.paid_at = pStart + 1;
      return e;
    };
    const checkout = (id = `evt_fx_online_checkout_${++seq}`): StripeEvent => ({
      id, type: 'checkout.session.completed', created: pStart + 5,
      data: { object: { id: csId, object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', amount_total: 150000, customer: cus, subscription: subId, invoice: invId, metadata: { ...md, enrollmentCandidate: 'true', enrollmentSettingsId: settings.id } } },
    });
    const liveSub = stripeSubscriptionLike({ id: subId, customer: cus, status: 'active', studioId: studio.id, userId: member.id, planId: full.id, periodStart: pStart, periodEnd: pEnd, latestInvoice: invId });
    stripe['retrieveSubscription'].mockResolvedValue(liveSub);
    stripe['listSubscriptionsForCustomer'].mockResolvedValue([]);
    stripe['findPaidInvoicePaymentIntentId']?.mockResolvedValue(null);
    return { studio, full, basic, member, owner, cash, bystander, bystanderCash, subId, invId, csId, pStart, pEnd, liveSub, created, paid, checkout };
  }

  type World = Awaited<ReturnType<typeof world>>;
  const stripeRows = (w: World) => prisma.subscription.findMany({ where: { stripeSubscriptionId: w.subId } });
  const entitledIds = async (w: World) =>
    (await prisma.subscription.findMany({ where: { studioId: w.studio.id, userId: w.member.id, ...currentlyEntitledSubscriptionWhere(new Date()) }, select: { id: true } })).map((s) => s.id);
  const openCases = (w: World) => prisma.billingReconciliationCase.findMany({ where: { userId: w.member.id, resolvedAt: null }, orderBy: { createdAt: 'asc' } });

  async function expectRecovered(w: World, endReason: SubscriptionEndReason) {
    const rows = await stripeRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: SubscriptionStatus.ACTIVE, source: SubscriptionSource.STRIPE, membershipPlanId: w.full.id, exclusiveGroupKey: 'CORE', cancelAtPeriodEnd: false });
    expect(rows[0].currentPeriodStart?.getTime()).toBe(w.pStart * 1000);
    expect(rows[0].currentPeriodEnd?.getTime()).toBe(w.pEnd * 1000);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: w.cash.id } })).toMatchObject({ status: SubscriptionStatus.CANCELED, endReason, supersededBySubscriptionId: rows[0].id });
    expect(await entitledIds(w)).toEqual([rows[0].id]);
    // The bystander's identical lapsed row is untouched.
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: w.bystanderCash.id } })).toEqual(w.bystanderCash);
    expect(stripeMutationCalls(stripe)).toBe(0);
    return rows[0];
  }

  it('R1: the incident sequence (created → invoice.paid → checkout) now grants access; the first-invoice payment is linked', async () => {
    const w = await world();
    await post(w.created()).expect(200);
    await post(w.paid()).expect(200);
    await post(w.checkout()).expect(200);

    const row = await expectRecovered(w, SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD);
    expect(await prisma.payment.findUniqueOrThrow({ where: { stripeInvoiceId: w.invId } })).toMatchObject({ status: 'SUCCEEDED', subscriptionId: row.id, amountCents: 150000 });
    expect((await prisma.stripeWebhookEvent.findMany()).every((e) => e.processed && e.lastError === null)).toBe(true);
    expect(await prisma.memberEnrollment.count({ where: { userId: w.member.id } })).toBe(1);
    expect(await openCases(w)).toEqual([]);

    // Booking access resolves to the new Stripe membership through the real service.
    const tpl = await createClassTemplate(prisma, w.studio.id, {});
    const cls = await createScheduledClass(prisma, w.studio.id, tpl.id, { startsAt: new Date(Date.now() + 2 * DAY), endsAt: new Date(Date.now() + 2 * DAY + HOUR) });
    const access = new BookingAccessService(new MembershipUsageService(prisma));
    const result = await prisma.$transaction((tx) => access.assertAccess(tx, w.studio.id, w.member.id, Role.MEMBER, cls.startsAt, 'America/Mexico_City', tpl.id, cls.id));
    expect(result.subscriptionId).toBe(row.id);
  });

  it('R2: invoice.paid BEFORE the subscription exists (benign race) opens no case, and the payment is linked when the row is created', async () => {
    const w = await world();
    await post(w.paid()).expect(200);
    expect(await prisma.payment.findUniqueOrThrow({ where: { stripeInvoiceId: w.invId } })).toMatchObject({ subscriptionId: null });
    expect(await openCases(w)).toEqual([]);

    await post(w.created()).expect(200);
    const row = await expectRecovered(w, SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD);
    expect((await prisma.payment.findUniqueOrThrow({ where: { stripeInvoiceId: w.invId } })).subscriptionId).toBe(row.id);
  });

  it('R3: checkout.session.completed first, then the subscription event: one row, one supersession, one enrollment', async () => {
    const w = await world();
    await post(w.checkout()).expect(200);
    await post(w.created()).expect(200);
    await post(w.paid()).expect(200);
    await expectRecovered(w, SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD);
    expect(await prisma.memberEnrollment.count({ where: { userId: w.member.id } })).toBe(1);
  });

  it('R4: concurrent and repeated deliveries converge on exactly one Stripe row and one supersession', async () => {
    const w = await world();
    const c = w.created('evt_fx_conc_created');
    const k = w.checkout('evt_fx_conc_checkout');
    await Promise.all([post(c), post(c), post(k), post(k), post(w.paid('evt_fx_conc_paid'))]);
    // Stripe's later automatic retries: every event ends processed.
    for (const e of [c, k]) await post(e).expect(200);
    await expectRecovered(w, SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD);
    expect(await prisma.subscription.count({ where: { userId: w.member.id, endReason: { not: null } } })).toBe(1);
    expect(await prisma.memberEnrollment.count({ where: { userId: w.member.id } })).toBe(1);
    expect((await prisma.stripeWebhookEvent.findMany()).every((e) => e.processed)).toBe(true);
  });

  it('R5: an expired CASH row of another plan in the same exclusive group is superseded as a plan change', async () => {
    const w = await world({ cashPlan: 'basic' });
    await post(w.created()).expect(200);
    await expectRecovered(w, SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE);
  });

  it('R6: a CASH membership still inside its paid window is never cancelled; the orphan is surfaced at once and a second purchase is refused', async () => {
    const w = await world({ cashEndsInMs: 5 * DAY });
    await post(w.created()).expect(200);
    expect(await stripeRows(w)).toHaveLength(0);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: w.cash.id } })).toMatchObject({ status: SubscriptionStatus.ACTIVE, endReason: null });
    const cases = await openCases(w);
    expect(cases.map((c) => [c.category, c.reasonCode, c.issueKey])).toEqual([['SUBSCRIPTION_IDENTITY_MISMATCH', 'STRIPE_ORPHAN', `${w.studio.id}:SUBSCRIPTION_IDENTITY_MISMATCH:${w.subId}`]]);

    // Stripe still bills this orphan: a new checkout (member or staff initiated) must be refused.
    stripe['listSubscriptionsForCustomer'].mockResolvedValue([w.liveSub]);
    // The plan's Stripe price is consistent, so the refusal below can only come from the orphan gate.
    stripe['retrievePrice'].mockResolvedValue({ id: 'price_fx_full', object: 'price', unit_amount: 150000, currency: 'mxn', active: true, product: 'prod_fx_full', recurring: { interval: 'month', interval_count: 1 } });
    const billing = app.get(BillingService);
    await expect(billing.createStaffInitiatedCheckoutSession({ actorUserId: w.owner.id, targetUserId: w.member.id, studioId: w.studio.id, planId: w.full.id }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'BILLING_STATE_REQUIRES_RECONCILIATION' }) });
    await expect(billing.createMemberCheckoutSession({ userId: w.member.id, studioId: w.studio.id, planId: w.full.id }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'BILLING_STATE_REQUIRES_RECONCILIATION' }) });
    expect(stripe['createCheckoutSession']).not.toHaveBeenCalled();
  });

  it('R7: if subscription creation fails AFTER the first invoice was paid, a CRITICAL paid-without-access case opens immediately', async () => {
    const w = await world();
    await post(w.paid()).expect(200);
    jest.spyOn(app.get(SubscriptionLifecycleService), 'reconcileSubscriptionPlansFromStripe').mockRejectedValueOnce(new Error('simulated creation failure'));
    await post(w.created()).expect(500);

    const cases = await openCases(w);
    expect(cases.map((c) => [c.category, c.severity, c.reasonCode, c.stripeInvoiceId])).toEqual([['PAID_WITHOUT_ENTITLEMENT', 'CRITICAL', 'NO_LOCAL_SUBSCRIPTION', w.invId]]);
    // Same key as the nightly detector: one case, never two.
    expect(cases[0].issueKey).toBe(`${w.studio.id}:PAID_WITHOUT_ENTITLEMENT:${w.invId}`);
  });

  it('R8: if subscription creation fails BEFORE the first invoice is paid, invoice.paid opens the CRITICAL case immediately', async () => {
    const w = await world();
    jest.spyOn(app.get(SubscriptionLifecycleService), 'reconcileSubscriptionPlansFromStripe').mockRejectedValueOnce(new Error('simulated creation failure'));
    await post(w.created()).expect(500);
    expect(await openCases(w)).toEqual([]);
    await post(w.paid()).expect(200);

    const cases = await openCases(w);
    expect(cases.map((c) => [c.category, c.severity, c.reasonCode, c.issueKey])).toEqual([['PAID_WITHOUT_ENTITLEMENT', 'CRITICAL', 'NO_LOCAL_SUBSCRIPTION', `${w.studio.id}:PAID_WITHOUT_ENTITLEMENT:${w.invId}`]]);
  });

  it('R9: a fixed-duration plan bought online after expired cash is created unentitled (PAST_DUE) until its paid cycle exists', async () => {
    const w = await world();
    await prisma.membershipPlan.update({ where: { id: w.full.id }, data: { entitlementDays: 30 } });
    await post(w.created()).expect(200);
    const rows = await stripeRows(w);
    expect(rows).toHaveLength(1);
    // The old supersede path inserted the row ACTIVE with no paid cycle; the normal path never does.
    expect(rows[0].status).toBe(SubscriptionStatus.PAST_DUE);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: w.cash.id } })).toMatchObject({ status: SubscriptionStatus.CANCELED, supersededBySubscriptionId: rows[0].id });
  });
});
