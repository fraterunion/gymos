import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MembershipPriceChangeScope,
  PaymentMethod,
  PaymentStatus,
  Role,
  SubscriptionSource,
  SubscriptionStatus,
} from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import {
  buildWorld,
  fixture,
  login,
  rebind,
  signedPost,
  stripeMutationCalls,
  type ReliabilityWorld,
  type StripeEvent,
} from './helpers/billing-reliability';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createUserWithPassword } from './helpers/factories';

/**
 * ARES Full Access goes from 1500 to 1700 for NEW customers only (FUTURE_ONLY), end to end:
 * real HTTP guards, real Postgres, and the real price-change, cash-sale, checkout and Stripe
 * webhook paths; Stripe itself is the shared e2e mock. Every existing membership keeps its
 * agreed price (`Subscription.priceCents`) through renewals, screens and webhooks.
 */
describe('Full Access price lock: legacy 1500 vs catalog 1700 (e2e)', () => {
  const LEGACY = 150_000;
  const CATALOG = 170_000;
  const NEGOTIATED = 140_000;
  const DAY = 86_400_000;
  const LEGACY_PRICE_ID = 'price_fx_full';
  const NEW_PRICE_ID = 'price_fx_full_1700';
  const MONTHLY_MXN = { currency: 'mxn', recurring: { interval: 'month', interval_count: 1 } };

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
    stripe['listSubscriptionsForCustomer']?.mockResolvedValue([]);
    stripe['findPaidInvoicePaymentIntentId']?.mockResolvedValue(null);
    stripe['findInvoiceIdForPaymentIntent']?.mockResolvedValue(null);
  });

  const http = () => request(app.getHttpServer());
  const post = (event: StripeEvent) => signedPost(app, webhookSecret, event);
  const get = (path: string, token: string) =>
    http().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).expect(200);
  const sell = (w: ReliabilityWorld, token: string, userId: string, amountCents: number, extra: Record<string, unknown> = {}) =>
    http()
      .post(`/api/v1/studios/${w.studio.id}/members/${userId}/offline-subscriptions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ planId: w.full.id, amountCents, paymentMethod: 'CASH', ...extra });
  const rowsOf = (userId: string) => prisma.subscription.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  const paymentsOf = (userId: string) => prisma.payment.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  /** Everything money or access hangs on for one member, without timestamps a no-op rewrite would bump. */
  const ledgerOf = async (userId: string) => ({
    subscriptions: (await rowsOf(userId)).map((s) => ({
      id: s.id,
      status: s.status,
      membershipPlanId: s.membershipPlanId,
      priceCents: s.priceCents,
      currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
    })),
    payments: (await paymentsOf(userId)).map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      status: p.status,
      paymentMethod: p.paymentMethod,
      stripeInvoiceId: p.stripeInvoiceId,
    })),
    cycles: (await prisma.membershipEntitlementCycle.findMany({ where: { userId }, orderBy: { id: 'asc' } })).map((c) => c.id),
  });

  /** An existing cash member whose lock the 1500 backfill (or an earlier sale) recorded. */
  async function cashMember(w: ReliabilityWorld, priceCents: number | null) {
    const user = await createUserWithPassword(prisma);
    await createMembership(prisma, user.id, w.studio.id, Role.MEMBER);
    const now = Date.now();
    const sub = await prisma.subscription.create({
      data: {
        studioId: w.studio.id,
        userId: user.id,
        membershipPlanId: w.full.id,
        status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.CASH,
        exclusiveGroupKey: 'CORE',
        currentPeriodStart: new Date(now - 25 * DAY),
        currentPeriodEnd: new Date(now + 5 * DAY),
        cancelAtPeriodEnd: true,
        priceCents,
      },
    });
    return { user, sub };
  }

  /**
   * ARES as of the rise: Full Access at 1500 with recorded locks (a card member and a cash member
   * at 1500, a negotiated cash member at 1400), then the owner raises the catalog to 1700 for
   * future sales through the real endpoint, which rotates the Stripe sale Price. Existing Stripe
   * items stay on the retired 1500 Price.
   */
  async function aresAfterFutureOnlyRise() {
    const w = await buildWorld(prisma);
    const now = Date.now();
    await prisma.subscription.update({
      where: { id: w.sub.id },
      data: { priceCents: LEGACY, currentPeriodStart: new Date(now - 10 * DAY), currentPeriodEnd: new Date(now + 20 * DAY) },
    });
    const legacyCash = await cashMember(w, LEGACY);
    const negotiated = await cashMember(w, NEGOTIATED);
    const newcomer = await createUserWithPassword(prisma);
    await createMembership(prisma, newcomer.id, w.studio.id, Role.MEMBER);

    stripe['createRecurringPrice']!.mockResolvedValueOnce({
      id: NEW_PRICE_ID, object: 'price', active: true, unit_amount: CATALOG, product: 'prod_fx_full', ...MONTHLY_MXN,
    });
    const ownerToken = await login(app, w.owner.email, w.owner.password);
    const rise = await http()
      .post(`/api/v1/studios/${w.studio.id}/membership-plans/${w.full.id}/price-changes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ scope: MembershipPriceChangeScope.FUTURE_ONLY, newPriceCents: CATALOG, idempotencyKey: 'ares-full-access-1700', confirm: true })
      .expect(200);
    expect(rise.body.status).toBe('COMPLETED');
    expect(await prisma.membershipPlan.findUniqueOrThrow({ where: { id: w.full.id } })).toMatchObject({
      priceCents: CATALOG,
      stripePriceId: NEW_PRICE_ID,
    });
    // FUTURE_ONLY touches no existing lock and no existing Stripe subscription.
    for (const [id, lock] of [[w.sub.id, LEGACY], [legacyCash.sub.id, LEGACY], [negotiated.sub.id, NEGOTIATED]] as const) {
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id } })).priceCents).toBe(lock);
    }
    expect(stripe['updateSubscription']?.mock.calls.length ?? 0).toBe(0);

    return {
      w,
      ownerToken,
      adminToken: await login(app, w.admin.email, w.admin.password),
      legacyCash,
      negotiated,
      newcomer,
    };
  }

  it('A/E: cash renewals keep each agreed price (legacy 1500, negotiated 1400) after the catalog rises to 1700', async () => {
    const { w, adminToken, legacyCash, negotiated } = await aresAfterFutureOnlyRise();

    // A member who holds a lock is charged that lock and nothing else, catalog included.
    for (const amount of [CATALOG, 160_000]) await sell(w, adminToken, legacyCash.user.id, amount).expect(400);
    for (const amount of [CATALOG, LEGACY]) await sell(w, adminToken, negotiated.user.id, amount).expect(400);
    expect(await prisma.payment.count()).toBe(0);

    await sell(w, adminToken, legacyCash.user.id, LEGACY).expect(201);
    await sell(w, adminToken, legacyCash.user.id, LEGACY).expect(201);
    await sell(w, adminToken, negotiated.user.id, NEGOTIATED).expect(201);

    // Original row, its renewal and the renewal of that renewal: all at 1500, one payment each.
    const legacyRows = await rowsOf(legacyCash.user.id);
    expect(legacyRows).toHaveLength(3);
    expect(legacyRows.map((s) => s.priceCents)).toEqual([LEGACY, LEGACY, LEGACY]);
    expect(legacyRows.filter((s) => s.status === SubscriptionStatus.ACTIVE)).toHaveLength(1);
    expect((await paymentsOf(legacyCash.user.id)).map((p) => [p.amountCents, p.paymentMethod, p.status])).toEqual([
      [LEGACY, PaymentMethod.CASH, PaymentStatus.SUCCEEDED],
      [LEGACY, PaymentMethod.CASH, PaymentStatus.SUCCEEDED],
    ]);

    expect((await rowsOf(negotiated.user.id)).map((s) => s.priceCents)).toEqual([NEGOTIATED, NEGOTIATED]);
    expect((await paymentsOf(negotiated.user.id)).map((p) => p.amountCents)).toEqual([NEGOTIATED]);
    expect((await prisma.membershipPlan.findUniqueOrThrow({ where: { id: w.full.id } })).priceCents).toBe(CATALOG);
  });

  it('C/I: a new customer sees and pays the 1700 catalog; existing members are offered their own lock', async () => {
    const { w, adminToken, legacyCash, negotiated, newcomer } = await aresAfterFutureOnlyRise();
    const newcomerToken = await login(app, newcomer.email, newcomer.password);

    const catalog = await get(`/studios/${w.studio.id}/membership-plans`, newcomerToken);
    expect((catalog.body as Array<{ id: string; priceCents: number }>).find((p) => p.id === w.full.id)?.priceCents).toBe(CATALOG);

    const deskPrice = async (userId: string) => {
      const res = await get(`/studios/${w.studio.id}/members/${userId}/purchase-options`, adminToken);
      return (res.body.options as Array<{ planId: string; effectivePriceCents?: number }>).find((o) => o.planId === w.full.id)
        ?.effectivePriceCents;
    };
    expect(await deskPrice(newcomer.id)).toBe(CATALOG);
    expect(await deskPrice(legacyCash.user.id)).toBe(LEGACY);
    expect(await deskPrice(negotiated.user.id)).toBe(NEGOTIATED);
    expect(await deskPrice(w.member.id)).toBe(LEGACY);

    // The legacy price is not for sale to someone who never held it.
    await sell(w, adminToken, newcomer.id, LEGACY).expect(400);
    await sell(w, adminToken, newcomer.id, CATALOG).expect(201);
    expect((await rowsOf(newcomer.id)).map((s) => [s.status, s.priceCents])).toEqual([[SubscriptionStatus.ACTIVE, CATALOG]]);
    expect((await paymentsOf(newcomer.id)).map((p) => p.amountCents)).toEqual([CATALOG]);
  });

  it('F: a membership without a recorded price is never charged the catalog; only an owner with a written note sets it, audited', async () => {
    const { w, ownerToken, adminToken } = await aresAfterFutureOnlyRise();
    const unlocked = await cashMember(w, null);

    await sell(w, adminToken, unlocked.user.id, CATALOG).expect(400);
    await sell(w, adminToken, unlocked.user.id, LEGACY).expect(400);
    await sell(w, adminToken, unlocked.user.id, LEGACY, { priceOverrideNote: 'Precio acordado 1500' }).expect(400);
    await sell(w, ownerToken, unlocked.user.id, CATALOG).expect(400);
    await sell(w, ownerToken, unlocked.user.id, LEGACY, { priceOverrideNote: '   ' }).expect(400);
    expect(await rowsOf(unlocked.user.id)).toHaveLength(1);
    expect(await paymentsOf(unlocked.user.id)).toHaveLength(0);

    await sell(w, ownerToken, unlocked.user.id, LEGACY, { priceOverrideNote: 'Precio acordado 1500 (alta 2026)' }).expect(201);
    const rows = await rowsOf(unlocked.user.id);
    expect(rows.map((s) => [s.status, s.priceCents])).toEqual([
      [SubscriptionStatus.CANCELED, null],
      [SubscriptionStatus.ACTIVE, LEGACY],
    ]);
    expect((await paymentsOf(unlocked.user.id)).map((p) => p.amountCents)).toEqual([LEGACY]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { studioId: w.studio.id, targetUserId: unlocked.user.id, action: 'CASH_SUBSCRIPTION_CREATED' },
    });
    expect(audit.actorUserId).toBe(w.owner.id);
    expect(audit.metadata).toMatchObject({
      catalogPriceCents: CATALOG,
      heldPriceCents: null,
      lockedPriceCents: LEGACY,
      priceOverride: true,
      priceLockMissing: true,
      priceOverrideNote: 'Precio acordado 1500 (alta 2026)',
    });

    // From now on the recorded lock governs like any other: the desk renews at 1500 only.
    await sell(w, adminToken, unlocked.user.id, CATALOG).expect(400);
    await sell(w, adminToken, unlocked.user.id, LEGACY).expect(201);
  });

  it('G/H: Member 360 and the member app show the agreed price, with 1700 only as the catalog reference', async () => {
    const { w, adminToken, legacyCash, negotiated } = await aresAfterFutureOnlyRise();

    type PricedMembership = { plan: { priceCents: number; catalogPriceCents: number } };
    const expectAgreed = (
      profile: { currentMembership: PricedMembership; activeSubscription: PricedMembership; memberships: PricedMembership[] },
      agreed: number,
    ) => {
      expect(profile.currentMembership.plan).toMatchObject({ priceCents: agreed, catalogPriceCents: CATALOG });
      expect(profile.activeSubscription.plan).toMatchObject({ priceCents: agreed, catalogPriceCents: CATALOG });
      expect(profile.memberships.length).toBeGreaterThan(0);
      expect(profile.memberships.map((m) => m.plan.priceCents)).toEqual(profile.memberships.map(() => agreed));
    };

    // Admin Member 360 (profile + subscription history).
    expectAgreed((await get(`/studios/${w.studio.id}/members/${legacyCash.user.id}`, adminToken)).body, LEGACY);
    const history = (await get(`/studios/${w.studio.id}/members/${legacyCash.user.id}/subscriptions`, adminToken)).body as Array<{
      id: string;
      priceCents: number;
      membershipPlan: { priceCents: number; catalogPriceCents: number };
    }>;
    expect(history.find((s) => s.id === legacyCash.sub.id)).toMatchObject({
      priceCents: LEGACY,
      membershipPlan: { priceCents: LEGACY, catalogPriceCents: CATALOG },
    });

    // Member app (/members/me): cash 1500, card 1500, negotiated 1400.
    const me = async (email: string, password: string) =>
      (await get(`/studios/${w.studio.id}/members/me`, await login(app, email, password))).body;
    expectAgreed(await me(legacyCash.user.email, legacyCash.user.password), LEGACY);
    expectAgreed(await me(w.member.email, w.member.password), LEGACY);
    expectAgreed(await me(negotiated.user.email, negotiated.user.password), NEGOTIATED);
  });

  it('B/J/K: the legacy card member renews on the retired 1500 Price; webhooks record 1500 once and never rewrite the lock', async () => {
    const { w } = await aresAfterFutureOnlyRise();
    const now = Date.now();
    const periodStart = Math.floor((now - 3_600_000) / 1000);
    const periodEnd = Math.floor((now - 3_600_000 + 30 * DAY) / 1000);
    await prisma.subscription.update({
      where: { id: w.sub.id },
      data: { currentPeriodStart: new Date((periodStart - 30 * 86_400) * 1000), currentPeriodEnd: new Date(periodStart * 1000) },
    });
    const mutationsBefore = stripeMutationCalls(stripe);

    // Stripe renews the existing item, still on the retired 1500 Price (no longer any plan's
    // sale Price), so the webhook resolves the plan from the subscription's metadata.
    const renewed = w.subscriptionEvent({ type: 'customer.subscription.updated', status: 'active', periodStart, periodEnd });
    expect(renewed.data.object.items.data[0].price).toMatchObject({ id: LEGACY_PRICE_ID, unit_amount: LEGACY });
    const paid = w.monthlyPaidInvoice({ invoiceId: 'in_fa_legacy_renewal', paidAt: periodStart + 60 });
    Object.assign(paid.data.object, { amount_paid: LEGACY, amount_due: LEGACY, total: LEGACY, subtotal: LEGACY });
    paid.data.object.lines.data[0].amount = LEGACY;
    paid.data.object.lines.data[0].period = { start: periodStart, end: periodEnd };

    await post(renewed).expect(200);
    await post(paid).expect(200);

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } });
    expect(after).toMatchObject({ status: SubscriptionStatus.ACTIVE, membershipPlanId: w.full.id, priceCents: LEGACY });
    expect(after.currentPeriodEnd?.getTime()).toBe(periodEnd * 1000);
    expect((await paymentsOf(w.member.id)).map((p) => [p.amountCents, p.paymentMethod, p.stripeInvoiceId])).toEqual([
      [LEGACY, PaymentMethod.STRIPE, 'in_fa_legacy_renewal'],
    ]);
    const settled = await ledgerOf(w.member.id);

    // Stripe redelivers both events, re-sends the invoice under a new event id, and emits
    // another update for the same period: nothing is duplicated and the lock never moves.
    await post(renewed).expect(200);
    await post(paid).expect(200);
    await post({ ...paid, id: `${paid.id}_redelivered` }).expect(200);
    await post({ ...renewed, id: `${renewed.id}_again` }).expect(200);
    expect(await ledgerOf(w.member.id)).toEqual(settled);
    expect(stripeMutationCalls(stripe)).toBe(mutationsBefore);
  });

  describe('B at the desk: the legacy card member moves to cash at period end', () => {
    let updateSubscription: jest.Mock;

    beforeEach(() => {
      updateSubscription = jest.fn().mockResolvedValue({ id: 'sub_fx_full', cancel_at_period_end: true });
      stripe['updateSubscription'] = updateSubscription;
    });

    afterEach(() => {
      delete stripe['updateSubscription'];
    });

    const membershipRowsOf = async (userId: string) =>
      (await rowsOf(userId)).map((s) => [s.source, s.status, s.priceCents]);

    it('pays 1500, never 1700, and the scheduled cash membership keeps 1500', async () => {
      const { w, adminToken } = await aresAfterFutureOnlyRise();

      await sell(w, adminToken, w.member.id, CATALOG, { stripeResolution: 'cancel_at_period_end' }).expect(400);
      await sell(w, adminToken, w.member.id, LEGACY).expect(409);
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(await paymentsOf(w.member.id)).toHaveLength(0);

      await sell(w, adminToken, w.member.id, LEGACY, { stripeResolution: 'cancel_at_period_end' }).expect(201);
      expect(updateSubscription).toHaveBeenCalledWith('sub_fx_full', { cancel_at_period_end: true }, expect.anything());
      expect(await membershipRowsOf(w.member.id)).toEqual([
        [SubscriptionSource.STRIPE, SubscriptionStatus.ACTIVE, LEGACY],
        [SubscriptionSource.CASH, SubscriptionStatus.SCHEDULED, LEGACY],
      ]);
      expect((await paymentsOf(w.member.id)).map((p) => [p.amountCents, p.paymentMethod])).toEqual([[LEGACY, PaymentMethod.CASH]]);
    });

    it('an owner one-off discount is charged once; the scheduled cash membership keeps the 1500 lock', async () => {
      const { w, ownerToken } = await aresAfterFutureOnlyRise();

      await sell(w, ownerToken, w.member.id, NEGOTIATED, {
        stripeResolution: 'cancel_at_period_end',
        priceOverrideNote: 'Descuento único autorizado',
      }).expect(201);
      expect(await membershipRowsOf(w.member.id)).toEqual([
        [SubscriptionSource.STRIPE, SubscriptionStatus.ACTIVE, LEGACY],
        [SubscriptionSource.CASH, SubscriptionStatus.SCHEDULED, LEGACY],
      ]);
      expect((await paymentsOf(w.member.id)).map((p) => p.amountCents)).toEqual([NEGOTIATED]);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { studioId: w.studio.id, targetUserId: w.member.id, action: 'STRIPE_TO_CASH_PERIOD_END_SCHEDULED' },
      });
      expect(audit.metadata).toMatchObject({
        amountCents: NEGOTIATED,
        catalogPriceCents: CATALOG,
        heldPriceCents: LEGACY,
        lockedPriceCents: LEGACY,
        priceOverride: true,
        priceLockMissing: false,
        priceOverrideNote: 'Descuento único autorizado',
      });
    });
  });

  it('D: a new card customer checks out on the 1700 Stripe Price and is locked at 1700; a stale Price is refused', async () => {
    const { w, newcomer } = await aresAfterFutureOnlyRise();
    const newcomerToken = await login(app, newcomer.email, newcomer.password);
    const checkout = () =>
      http()
        .post(`/api/v1/studios/${w.studio.id}/membership-plans/${w.full.id}/checkout`)
        .set('Authorization', `Bearer ${newcomerToken}`)
        .send({});

    // A sale Price that no longer matches the catalog is never charged.
    stripe['retrievePrice']!.mockResolvedValue({ id: NEW_PRICE_ID, active: true, unit_amount: LEGACY, product: 'prod_fx_full', ...MONTHLY_MXN });
    await checkout().expect(400);
    expect(stripe['createCheckoutSession']).not.toHaveBeenCalled();

    stripe['retrievePrice']!.mockResolvedValue({ id: NEW_PRICE_ID, active: true, unit_amount: CATALOG, product: 'prod_fx_full', ...MONTHLY_MXN });
    stripe['createOrRetrieveCustomer']!.mockResolvedValueOnce({ id: 'cus_fa_new', object: 'customer' });
    const started = await checkout().expect(200);
    expect(started.body).toMatchObject({ action: 'checkout' });
    expect(stripe['createCheckoutSession']).toHaveBeenCalledTimes(1);
    expect(stripe['createCheckoutSession']!.mock.calls[0]![0]).toMatchObject({
      mode: 'subscription',
      line_items: [{ price: NEW_PRICE_ID, quantity: 1 }],
      subscription_data: { metadata: { userId: newcomer.id, studioId: w.studio.id, planId: w.full.id } },
    });

    // Stripe confirms the subscription on the 1700 Price and the first invoice.
    const now = Date.now();
    const periodStart = Math.floor((now - 3_600_000) / 1000);
    const periodEnd = Math.floor((now - 3_600_000 + 30 * DAY) / 1000);
    const md = { userId: newcomer.id, studioId: w.studio.id, planId: w.full.id };
    const tokens = {
      sub_fx0026: 'sub_fa_new', price_fx0027: NEW_PRICE_ID, prod_fx0028: 'prod_fx_full', si_fx0029: 'si_fa_new', cus_fx0030: 'cus_fa_new',
      sub_fx0008: 'sub_fa_new', price_fx0010: NEW_PRICE_ID, prod_fx0011: 'prod_fx_full', si_fx0009: 'si_fa_new', cus_fx0014: 'cus_fa_new',
      in_fx0006: 'in_fa_new_first',
    };
    const created = rebind(fixture('dahlia-subscription-deleted-payment-failed'), tokens);
    created.id = 'evt_fa_new_created';
    created.type = 'customer.subscription.created';
    Object.assign(created.data.object, {
      status: 'active', canceled_at: null, ended_at: null, cancel_at_period_end: false, metadata: md, latest_invoice: 'in_fa_new_first',
      cancellation_details: { reason: null, comment: null, feedback: null, feedback_option: null },
    });
    created.data.object.items.data[0].price.unit_amount = CATALOG;
    created.data.object.items.data[0].current_period_start = periodStart;
    created.data.object.items.data[0].current_period_end = periodEnd;
    created.data.previous_attributes = null;
    const firstInvoice = rebind(fixture('dahlia-invoice-paid-monthly-renewal'), tokens);
    firstInvoice.id = 'evt_fa_new_paid';
    Object.assign(firstInvoice.data.object, {
      billing_reason: 'subscription_create', amount_paid: CATALOG, amount_due: CATALOG, total: CATALOG, subtotal: CATALOG,
    });
    firstInvoice.data.object.parent.subscription_details.metadata = md;
    firstInvoice.data.object.lines.data[0].amount = CATALOG;
    firstInvoice.data.object.lines.data[0].period = { start: periodStart, end: periodEnd };
    firstInvoice.data.object.status_transitions.paid_at = periodStart + 1;

    await post(created).expect(200);
    await post(firstInvoice).expect(200);
    await post(created).expect(200);
    await post(firstInvoice).expect(200);

    expect((await rowsOf(newcomer.id)).map((s) => [s.source, s.status, s.stripeSubscriptionId, s.priceCents])).toEqual([
      [SubscriptionSource.STRIPE, SubscriptionStatus.ACTIVE, 'sub_fa_new', CATALOG],
    ]);
    expect((await paymentsOf(newcomer.id)).map((p) => [p.amountCents, p.paymentMethod])).toEqual([[CATALOG, PaymentMethod.STRIPE]]);
    // The legacy card member is untouched by the newcomer's purchase.
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: w.sub.id } })).priceCents).toBe(LEGACY);
  });
});
