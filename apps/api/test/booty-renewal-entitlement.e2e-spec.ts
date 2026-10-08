import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingInterval, ClassStatus, PaymentMethod, PaymentStatus, Role, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import Stripe from 'stripe';
import request from 'supertest';
import { MEMBER_ERRORS } from '../src/member-facing/member-errors';
import { MembershipUsageService } from '../src/membership-usage/membership-usage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';

/**
 * Booty Lab renewal incident (2026-10-02), end to end: real Postgres (unique indexes, the
 * entitlement-cycle ledger trigger, advisory locks), real webhook signature verification, and the
 * REAL sanitized `2026-05-27.dahlia` payloads from test/fixtures/stripe-webhooks.
 * Stripe HTTP is mocked; nothing here can reach Stripe.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StripeEvent = { id: string; type: string; created: number; data: { object: any } };

const DAY_MS = 86_400_000;
const OCT_2 = new Date('2026-10-02T16:54:40.000Z');
const NOV_16 = new Date('2026-11-16T16:54:40.000Z');

function fixture(name: string): StripeEvent {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures/stripe-webhooks', `${name}.json`), 'utf8')) as StripeEvent;
}

/** Re-points fixture ids (exact quoted tokens) at this test's database rows. */
function rebind(event: StripeEvent, tokens: Record<string, string>): StripeEvent {
  let json = JSON.stringify(event);
  for (const [from, to] of Object.entries(tokens)) json = json.split(`"${from}"`).join(`"${to}"`);
  return JSON.parse(json) as StripeEvent;
}

describe('Booty Lab renewal entitlement (e2e, real dahlia payloads)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: Record<string, jest.Mock>;
  let webhookSecret: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stripe = app.get(StripeService) as unknown as Record<string, jest.Mock>;
    webhookSecret = app.get(ConfigService).getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
  });

  afterAll(async () => {
    await truncateAll(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    jest.clearAllMocks();
    // clearAllMocks keeps implementations: reset the ones tests override, so nothing leaks.
    stripe['listSubscriptionsForCustomer'].mockResolvedValue([]);
    stripe['findPaidInvoicePaymentIntentId'].mockResolvedValue(null);
  });

  function post(event: StripeEvent) {
    const payload = JSON.stringify(event);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    return request(app.getHttpServer())
      .post('/api/v1/stripe/webhook')
      .set('Stripe-Signature', header)
      .set('Content-Type', 'application/json')
      .send(payload);
  }

  async function login(email: string, password: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  /**
   * The production situation: a card-paying Booty Lab member whose first cycle came from the
   * Aug 20 migration backfill, renewing at `renewalStart` (default: the real Oct 2 16:54:40Z).
   */
  async function world(renewalStart: Date = OCT_2) {
    const initialStart = new Date(renewalStart.getTime() - 45 * DAY_MS);
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const bootyTemplate = await prisma.classTemplate.create({
      data: { studioId: studio.id, name: 'Booty Lab', durationMinutes: 60, defaultCapacity: 12, equipment: [], tags: [] },
    });
    const strengthTemplate = await prisma.classTemplate.create({
      data: { studioId: studio.id, name: 'Strength', durationMinutes: 60, defaultCapacity: 12, equipment: [], tags: [] },
    });
    const booty = await prisma.membershipPlan.create({
      data: {
        studioId: studio.id, name: 'Booty Lab by Etzia', priceCents: 80000, currency: 'mxn', billingInterval: BillingInterval.MONTHLY,
        active: true, allClassesAccess: false, classCredits: 4, entitlementDays: 45, exclusiveGroup: null,
        stripePriceId: 'price_fx_booty_45d', stripeProductId: 'prod_fx_booty',
        classTemplateAccess: { create: [{ studioId: studio.id, classTemplateId: bootyTemplate.id }] },
      },
    });
    const full = await prisma.membershipPlan.create({
      data: {
        studioId: studio.id, name: 'Full Access', priceCents: 150000, currency: 'mxn', billingInterval: BillingInterval.MONTHLY,
        active: true, allClassesAccess: false, exclusiveGroup: 'CORE', stripePriceId: 'price_fx_full', stripeProductId: 'prod_fx_full',
        classTemplateAccess: { create: [{ studioId: studio.id, classTemplateId: strengthTemplate.id }] },
      },
    });
    const member = await createUserWithPassword(prisma);
    await prisma.user.update({ where: { id: member.id }, data: { stripeCustomerId: 'cus_fx_booty_member' } });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const owner = await createUserWithPassword(prisma);
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const sub = await prisma.subscription.create({
      data: {
        studioId: studio.id, userId: member.id, membershipPlanId: booty.id, status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.STRIPE, stripeSubscriptionId: 'sub_fx_booty_member', exclusiveGroupKey: null,
        currentPeriodStart: initialStart, currentPeriodEnd: renewalStart, entitlementEndsAt: renewalStart,
      },
    });
    await prisma.membershipEntitlementCycle.create({
      data: {
        id: `backfill_${sub.id}`, studioId: studio.id, userId: member.id, subscriptionId: sub.id, membershipPlanId: booty.id,
        startsAt: initialStart, endsAt: renewalStart, creditLimit: 4, source: SubscriptionSource.STRIPE, stripeInvoiceId: 'in_fx_booty_initial',
      },
    });
    await prisma.payment.create({
      data: {
        studioId: studio.id, userId: member.id, subscriptionId: null, membershipPlanId: booty.id, amountCents: 80000, currency: 'mxn',
        status: PaymentStatus.SUCCEEDED, paymentMethod: PaymentMethod.STRIPE, stripeInvoiceId: 'in_fx_booty_initial', paidAt: initialStart,
      },
    });
    const bootyTokens = { fx_user_booty_member: member.id, fx_studio_ares: studio.id, fx_plan_booty: booty.id };
    const renewal = () => rebind(fixture('dahlia-invoice-paid-booty-renewal'), bootyTokens);
    return { studio, booty, full, member, owner, sub, bootyTemplate, strengthTemplate, initialStart, renewalStart, bootyTokens, renewal };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function addFullAccess(w: World) {
    return prisma.subscription.create({
      data: {
        studioId: w.studio.id, userId: w.member.id, membershipPlanId: w.full.id, status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.STRIPE, stripeSubscriptionId: 'sub_fx_full', exclusiveGroupKey: 'CORE',
        currentPeriodStart: new Date(Date.now() - 10 * DAY_MS), currentPeriodEnd: new Date(Date.now() + 20 * DAY_MS),
      },
    });
  }

  /** A real dahlia full-access event re-pointed at this member's Full Access subscription. */
  function fullAccessEvent(w: World, name: string): StripeEvent {
    const event = rebind(fixture(name), {
      sub_fx0008: 'sub_fx_full', price_fx0010: 'price_fx_full', prod_fx0011: 'prod_fx_full', si_fx0009: 'si_fx_full', cus_fx0014: 'cus_fx_booty_member',
      sub_fx0026: 'sub_fx_full', price_fx0027: 'price_fx_full', prod_fx0028: 'prod_fx_full', si_fx0029: 'si_fx_full', cus_fx0030: 'cus_fx_booty_member',
      fx_studio_ares: w.studio.id,
    });
    const metadata = { userId: w.member.id, studioId: w.studio.id, planId: w.full.id };
    const obj = event.data.object;
    if (obj.object === 'invoice') obj.parent.subscription_details.metadata = metadata;
    else obj.metadata = metadata;
    return event;
  }

  const cyclesOf = (subscriptionId: string) =>
    prisma.membershipEntitlementCycle.findMany({ where: { subscriptionId }, orderBy: { startsAt: 'asc' } });
  const paymentsFor = (stripeInvoiceId: string) => prisma.payment.findMany({ where: { stripeInvoiceId } });
  const storedEvent = (stripeEventId: string) => prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { stripeEventId } });
  const STRIPE_MUTATIONS = ['updateSubscription', 'cancelSubscription', 'scheduleSubscriptionPriceChangeAtPeriodEnd', 'createRecurringPrice', 'deactivatePrice'];
  const stripeMutationCalls = () => STRIPE_MUTATIONS.reduce((n, m) => n + (stripe[m]?.mock.calls.length ?? 0), 0);

  it('grants exactly one 4-credit Oct 2 → Nov 16 cycle from the real Oct 2 renewal and records one Payment', async () => {
    const w = await world();
    stripe['findPaidInvoicePaymentIntentId'].mockResolvedValueOnce('pi_fx_booty_renewal');

    await post(w.renewal()).expect(200);

    const cycles = await cyclesOf(w.sub.id);
    expect(cycles.map((c) => [c.startsAt.toISOString(), c.endsAt.toISOString(), c.creditLimit, c.stripeInvoiceId])).toEqual([
      [w.initialStart.toISOString(), OCT_2.toISOString(), 4, 'in_fx_booty_initial'],
      [OCT_2.toISOString(), NOV_16.toISOString(), 4, 'in_fx_booty_renewal'],
    ]);
    const payments = await paymentsFor('in_fx_booty_renewal');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      amountCents: 80000, currency: 'mxn', status: PaymentStatus.SUCCEEDED, paymentMethod: PaymentMethod.STRIPE,
      subscriptionId: w.sub.id, stripePaymentIntentId: 'pi_fx_booty_renewal',
    });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } })).toMatchObject({
      status: SubscriptionStatus.ACTIVE, currentPeriodStart: OCT_2, currentPeriodEnd: NOV_16, entitlementEndsAt: NOV_16,
    });
    expect(await storedEvent('evt_fx_booty_renewal_paid')).toMatchObject({ processed: true, lastError: null, attemptCount: 1 });
    expect(stripeMutationCalls()).toBe(0);
  });

  it('keeps the Payment, dead-letters, and flags Member 360 + the audit when the grant cannot run; a later delivery repairs it once', async () => {
    const w = await world();
    const ownerToken = await login(w.owner.email, w.owner.password);
    // Stripe really holds this subscription (so the audit has no unrelated orphan findings).
    stripe['listSubscriptionsForCustomer'].mockResolvedValue([rebind(fixture('dahlia-subscription-updated-booty-renewal'), w.bootyTokens).data.object]);
    // A paid period the plan cannot accept: the plan duration was edited to 30 days.
    await prisma.membershipPlan.update({ where: { id: w.booty.id }, data: { entitlementDays: 30 } });

    await post(w.renewal()).expect(500);

    expect(await paymentsFor('in_fx_booty_renewal')).toHaveLength(1);
    expect(await cyclesOf(w.sub.id)).toHaveLength(1);
    expect(await storedEvent('evt_fx_booty_renewal_paid')).toMatchObject({
      processed: false, attemptCount: 1, lastError: expect.stringContaining('[fixed-duration-entitlement:PERIOD_MISMATCH] invoice in_fx_booty_renewal'),
    });

    // Member 360: payment state and entitlement state are not conflated, and renewal is not offered.
    const profile = await request(app.getHttpServer()).get(`/api/v1/studios/${w.studio.id}/members/${w.member.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const items = profile.body.operations.attentionItems as Array<{ code: string; action: string | null }>;
    expect(items[0]).toMatchObject({ code: 'PAID_WITHOUT_ENTITLEMENT', action: 'REVIEW_BILLING' });
    expect(items.find((i) => i.code === 'EXPIRED')).toMatchObject({ action: 'REVIEW_BILLING' });
    expect(profile.body.currentMembership.paidWithoutEntitlement).toMatchObject({ stripeInvoiceId: 'in_fx_booty_renewal', amountCents: 80000 });
    const audit = await request(app.getHttpServer()).get(`/api/v1/studios/${w.studio.id}/billing/reconciliation-audit`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(audit.body.findings).toEqual(expect.arrayContaining([expect.objectContaining({ issue: 'paid_without_entitlement', severity: 'critical', userId: w.member.id })]));
    expect(audit.body.status).toBe('attention_required');

    // Plan corrected; Stripe (or an approved operator resend) delivers the same event again.
    await prisma.membershipPlan.update({ where: { id: w.booty.id }, data: { entitlementDays: 45 } });
    await post(w.renewal()).expect(200);

    expect(await paymentsFor('in_fx_booty_renewal')).toHaveLength(1);
    expect((await cyclesOf(w.sub.id)).map((c) => c.stripeInvoiceId)).toEqual(['in_fx_booty_initial', 'in_fx_booty_renewal']);
    expect(await storedEvent('evt_fx_booty_renewal_paid')).toMatchObject({ processed: true, attemptCount: 2 });
    const healed = await request(app.getHttpServer()).get(`/api/v1/studios/${w.studio.id}/members/${w.member.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((healed.body.operations.attentionItems as Array<{ code: string }>).map((i) => i.code)).not.toContain('PAID_WITHOUT_ENTITLEMENT');
    expect(healed.body.currentMembership.paidWithoutEntitlement).toBeNull();
    const healedAudit = await request(app.getHttpServer()).get(`/api/v1/studios/${w.studio.id}/billing/reconciliation-audit`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect((healedAudit.body.findings as Array<{ issue: string }>).map((f) => f.issue)).not.toContain('paid_without_entitlement');
    // Local now mirrors Stripe exactly (period Oct 2 → Nov 16): nothing left to flag.
    expect(healedAudit.body.status).toBe('healthy');
  });

  it('duplicate and concurrent deliveries create exactly one Payment and one cycle', async () => {
    const w = await world();
    const results = await Promise.all(Array.from({ length: 5 }, () => post(w.renewal())));
    for (const res of results) expect(res.status).toBe(200);
    await post(w.renewal()).expect(200);
    await post(w.renewal()).expect(200);

    expect(await paymentsFor('in_fx_booty_renewal')).toHaveLength(1);
    expect((await cyclesOf(w.sub.id)).filter((c) => c.stripeInvoiceId === 'in_fx_booty_renewal')).toHaveLength(1);
    expect(await cyclesOf(w.sub.id)).toHaveLength(2);
  });

  it('renews a grandfathered subscriber billed at an older Price of the same product, without touching Stripe or the catalog', async () => {
    const w = await world();
    await prisma.membershipPlan.update({ where: { id: w.booty.id }, data: { stripePriceId: 'price_fx_booty_45d_v2', priceCents: 90000 } });

    await post(w.renewal()).expect(200);

    expect((await cyclesOf(w.sub.id))[1]).toMatchObject({ startsAt: OCT_2, endsAt: NOV_16, creditLimit: 4 });
    expect((await paymentsFor('in_fx_booty_renewal'))[0].amountCents).toBe(80000); // what Stripe actually charged
    expect(await prisma.membershipPlan.findUniqueOrThrow({ where: { id: w.booty.id } })).toMatchObject({ stripePriceId: 'price_fx_booty_45d_v2', priceCents: 90000 });
    expect(stripeMutationCalls()).toBe(0); // no subscription price update, no migration
  });

  it('fills a historical gap behind a newer cycle; the ledger trigger accepts the adjacent windows', async () => {
    const w = await world();
    const dec31 = new Date('2026-12-31T16:54:40.000Z');
    await prisma.membershipEntitlementCycle.create({
      data: {
        studioId: w.studio.id, userId: w.member.id, subscriptionId: w.sub.id, membershipPlanId: w.booty.id,
        startsAt: NOV_16, endsAt: dec31, creditLimit: 4, source: SubscriptionSource.STRIPE, stripeInvoiceId: 'in_fx_next',
      },
    });
    await prisma.subscription.update({ where: { id: w.sub.id }, data: { currentPeriodStart: NOV_16, currentPeriodEnd: dec31, entitlementEndsAt: dec31 } });

    await post(w.renewal()).expect(200);

    expect((await cyclesOf(w.sub.id)).map((c) => c.stripeInvoiceId)).toEqual(['in_fx_booty_initial', 'in_fx_booty_renewal', 'in_fx_next']);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } })).toMatchObject({ currentPeriodStart: NOV_16, entitlementEndsAt: dec31 });
  });

  it('refuses a paid period that overlaps a different cycle — Payment kept, no cycle written', async () => {
    // The backfilled cycle ends one hour AFTER the period Stripe renewed from.
    const w = await world(new Date(OCT_2.getTime() + 3_600_000));

    await post(w.renewal()).expect(500);

    expect(await paymentsFor('in_fx_booty_renewal')).toHaveLength(1);
    expect(await cyclesOf(w.sub.id)).toHaveLength(1);
    expect((await storedEvent('evt_fx_booty_renewal_paid')).lastError).toContain('OVERLAPS_EXISTING_CYCLE');
  });

  it('grants the renewal when a zero-length one-off fee rides on the same invoice', async () => {
    const w = await world();
    const event = w.renewal();
    event.data.object.amount_paid += 20000;
    event.data.object.lines.data.push({
      id: 'il_fee', object: 'line_item', amount: 20000, subtotal: 20000, currency: 'mxn', period: { start: 1790960080, end: 1790960080 },
      parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: 'ii_fee', proration: false, proration_details: { credited_items: null }, subscription: null }, subscription_item_details: null },
      pricing: { type: 'price_details', price_details: { price: 'price_fee', product: 'prod_fee' }, unit_amount_decimal: '20000' },
    });

    await post(event).expect(200);

    expect((await cyclesOf(w.sub.id))[1]).toMatchObject({ startsAt: OCT_2, endsAt: NOV_16, creditLimit: 4 });
    expect((await paymentsFor('in_fx_booty_renewal'))[0].amountCents).toBe(100000);
  });

  it('a renewal grant racing customer.subscription.updated always ends on the paid cycle (member lock)', async () => {
    for (let round = 0; round < 3; round += 1) {
      await truncateAll(prisma);
      const w = await world();
      const subUpdated = rebind(fixture('dahlia-subscription-updated-booty-renewal'), w.bootyTokens);
      const [paid, updated] = await Promise.all([post(w.renewal()), post(subUpdated)]);
      expect([paid.status, updated.status]).toEqual([200, 200]);
      expect(await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } })).toMatchObject({
        currentPeriodStart: OCT_2, currentPeriodEnd: NOV_16, entitlementEndsAt: NOV_16,
      });
    }
  });

    it('denies booking before the grant and allows exactly 4 Booty Lab bookings after it; prior-cycle usage is unchanged', async () => {
    const renewalStart = new Date(Math.floor((Date.now() - 2 * DAY_MS) / 1000) * 1000);
    const w = await world(renewalStart);
    const memberToken = await login(w.member.email, w.member.password);

    // Three classes consumed in the backfilled cycle, attributed like production: the first two
    // predate attribution (NULL), the third is explicitly attributed (Aug 20 / Aug 27 / Sep 10).
    for (const [offset, attributed] of [[2, false], [9, false], [23, true]] as const) {
      const startsAt = new Date(w.initialStart.getTime() + offset * DAY_MS);
      const past = await prisma.scheduledClass.create({
        data: { studioId: w.studio.id, classTemplateId: w.bootyTemplate.id, capacity: 10, status: ClassStatus.SCHEDULED, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) },
      });
      await prisma.attendance.create({
        data: { studioId: w.studio.id, scheduledClassId: past.id, userId: w.member.id, method: 'MANUAL', checkedInAt: startsAt, subscriptionId: attributed ? w.sub.id : null },
      });
    }
    const historyBefore = {
      cycle: await prisma.membershipEntitlementCycle.findUniqueOrThrow({ where: { id: `backfill_${w.sub.id}` } }),
      attendances: await prisma.attendance.findMany({ where: { userId: w.member.id }, orderBy: { checkedInAt: 'asc' } }),
    };
    const usage = app.get(MembershipUsageService);
    const oldWindow = { start: w.initialStart, end: renewalStart };
    expect((await usage.getUsageForPeriod(prisma, w.studio.id, w.member.id, oldWindow, 4, w.sub.id)).creditsUsed).toBe(3);
    const future = [];
    for (let i = 1; i <= 5; i += 1) {
      const startsAt = new Date(Date.now() + i * DAY_MS);
      future.push(await prisma.scheduledClass.create({
        data: { studioId: w.studio.id, classTemplateId: w.bootyTemplate.id, capacity: 10, status: ClassStatus.SCHEDULED, startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000) },
      }));
    }
    const book = (classId: string) =>
      request(app.getHttpServer()).post(`/api/v1/studios/${w.studio.id}/classes/${classId}/bookings`).set('Authorization', `Bearer ${memberToken}`);

    const denied = await book(future[0].id).expect(403);
    expect(denied.body.message).toBe(MEMBER_ERRORS.membershipExpired);

    // The paid renewal, re-based so its 45-day period started two days ago.
    const event = w.renewal();
    const line = event.data.object.lines.data[0];
    const startSec = renewalStart.getTime() / 1000;
    line.period = { start: startSec, end: startSec + 45 * 86_400 };
    await post(event).expect(200);

    for (const cls of future.slice(0, 4)) await book(cls.id).expect(201);
    const exhausted = await book(future[4].id).expect(403);
    expect(exhausted.body.message).toBe(MEMBER_ERRORS.creditsExhausted);

    // History is untouched: the backfilled cycle row and every usage row are byte-identical.
    expect(await prisma.membershipEntitlementCycle.findUniqueOrThrow({ where: { id: `backfill_${w.sub.id}` } })).toEqual(historyBefore.cycle);
    expect(await prisma.attendance.findMany({ where: { userId: w.member.id }, orderBy: { checkedInAt: 'asc' } })).toEqual(historyBefore.attendances);
    // The new cycle spent exactly its own 4 credits.
    const current = await usage.getUsageForPeriod(prisma, w.studio.id, w.member.id, { start: renewalStart, end: new Date(renewalStart.getTime() + 45 * DAY_MS) }, 4, w.sub.id);
    expect(current.creditsUsed).toBe(4);
    // Pre-existing legacy-attribution behaviour (unchanged by this fix): a NULL-attributed event is
    // owned through the subscription's CURRENT window, so once the period moves to the new cycle a
    // recount of the old window only sees the explicitly attributed usage.
    expect((await usage.getUsageForPeriod(prisma, w.studio.id, w.member.id, oldWindow, 4, w.sub.id)).creditsUsed).toBe(1);
  });

  it('renews only Booty Lab for a Full Access + Booty Lab member', async () => {
    const w = await world();
    const fullSub = await addFullAccess(w);

    await post(w.renewal()).expect(200);

    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: fullSub.id } })).toEqual(fullSub);
    expect(await cyclesOf(fullSub.id)).toHaveLength(0);
    expect(await cyclesOf(w.sub.id)).toHaveLength(2);
  });

  it('a monthly renewal records its Payment and grants no cycle; subscription.updated syncs the item period', async () => {
    const w = await world();
    const fullSub = await addFullAccess(w);
    const invoiceEvent = fullAccessEvent(w, 'dahlia-invoice-paid-monthly-renewal');

    await post(invoiceEvent).expect(200);

    const payments = await paymentsFor(invoiceEvent.data.object.id as string);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amountCents: 60000, subscriptionId: fullSub.id });
    expect(await cyclesOf(fullSub.id)).toHaveLength(0);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: fullSub.id } })).toEqual(fullSub);

    const subEvent = rebind(fixture('dahlia-subscription-updated-booty-renewal'), {
      sub_fx_booty_member: 'sub_fx_full', price_fx_booty_45d: 'price_fx_full', prod_fx_booty: 'prod_fx_full', si_fx_booty_member: 'si_fx_full',
      fx_studio_ares: w.studio.id,
    });
    subEvent.id = 'evt_fx_full_sub_updated';
    subEvent.data.object.metadata = { userId: w.member.id, studioId: w.studio.id, planId: w.full.id };
    const nextStart = Math.floor((Date.now() + 20 * DAY_MS) / 1000);
    subEvent.data.object.items.data[0].current_period_start = nextStart;
    subEvent.data.object.items.data[0].current_period_end = nextStart + 30 * 86_400;
    await post(subEvent).expect(200);

    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: fullSub.id } })).toMatchObject({
      status: SubscriptionStatus.ACTIVE, currentPeriodStart: new Date(nextStart * 1000), currentPeriodEnd: new Date((nextStart + 30 * 86_400) * 1000), entitlementEndsAt: null,
    });
  });

  it('subscription.updated before and after invoice.paid converges on the paid cycle', async () => {
    const w = await world();
    const subUpdated = rebind(fixture('dahlia-subscription-updated-booty-renewal'), w.bootyTokens);

    await post(subUpdated).expect(200); // Stripe advanced the period; nothing is paid yet
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } })).toMatchObject({ currentPeriodEnd: OCT_2, entitlementEndsAt: OCT_2 });

    await post(w.renewal()).expect(200);
    await post({ ...subUpdated, id: 'evt_fx_booty_sub_updated_again' }).expect(200);

    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } })).toMatchObject({
      status: SubscriptionStatus.ACTIVE, currentPeriodStart: OCT_2, currentPeriodEnd: NOV_16, entitlementEndsAt: NOV_16,
    });
  });

  it('a Stripe cancellation followed by a late payment_failed stays CANCELED; a stale failure after payment changes nothing', async () => {
    const w = await world();
    const fullSub = await addFullAccess(w);

    await post(fullAccessEvent(w, 'dahlia-subscription-deleted-payment-failed')).expect(200);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: fullSub.id } })).status).toBe(SubscriptionStatus.CANCELED);
    const lateFailure = fullAccessEvent(w, 'dahlia-invoice-payment-failed-after-delete');
    await post(lateFailure).expect(200);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: fullSub.id } })).status).toBe(SubscriptionStatus.CANCELED);
    expect((await paymentsFor(lateFailure.data.object.id as string))[0]).toMatchObject({ status: PaymentStatus.FAILED });

    // Stale failure for the Booty invoice Stripe already settled.
    await post(w.renewal()).expect(200);
    const staleFailure = rebind(fixture('dahlia-invoice-payment-failed-after-delete'), {
      sub_fx0026: 'sub_fx_booty_member', cus_fx0030: 'cus_fx_booty_member', fx_studio_ares: w.studio.id,
    });
    staleFailure.id = 'evt_fx_booty_stale_failure';
    staleFailure.data.object.id = 'in_fx_booty_renewal';
    await post(staleFailure).expect(200);
    expect((await paymentsFor('in_fx_booty_renewal'))[0]).toMatchObject({ status: PaymentStatus.SUCCEEDED, amountCents: 80000 });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } })).status).toBe(SubscriptionStatus.ACTIVE);
  });

  it('unpaid, foreign-subscription and fee-only invoices never grant an entitlement', async () => {
    const w = await world();

    const unpaid = w.renewal();
    unpaid.id = 'evt_fx_unpaid';
    unpaid.data.object.status = 'open';
    await post(unpaid).expect(200);
    expect(await paymentsFor('in_fx_booty_renewal')).toHaveLength(0);

    const foreign = w.renewal();
    foreign.id = 'evt_fx_foreign';
    foreign.data.object.lines.data[0].parent.subscription_item_details.subscription = 'sub_fx_another_membership';
    await post(foreign).expect(500);
    expect((await storedEvent('evt_fx_foreign')).lastError).toContain('NO_SERVICE_LINE');

    const feeOnly = w.renewal();
    feeOnly.id = 'evt_fx_fee_only';
    feeOnly.data.object.id = 'in_fx_fee_only';
    feeOnly.data.object.lines.data = [{
      id: 'il_fee', object: 'line_item', amount: 80000, subtotal: 80000, currency: 'mxn', period: { start: 1790960080, end: 1790960080 },
      parent: { type: 'invoice_item_details', invoice_item_details: { invoice_item: 'ii_fee', proration: false, proration_details: null, subscription: 'sub_fx_booty_member' }, subscription_item_details: null },
      pricing: { type: 'price_details', price_details: { price: 'price_fee', product: 'prod_fee' }, unit_amount_decimal: '80000' },
    }];
    await post(feeOnly).expect(500);
    expect((await storedEvent('evt_fx_fee_only')).lastError).toContain('NO_SERVICE_LINE');

    expect(await cyclesOf(w.sub.id)).toHaveLength(1);
  });
});
