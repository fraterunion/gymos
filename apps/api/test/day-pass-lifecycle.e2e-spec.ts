import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DayPassStatus, Role } from '@prisma/client';
import Stripe from 'stripe';
import request from 'supertest';
import { DayPassAttemptSweepService } from '../src/day-passes/day-pass-attempt-sweep.service';
import { MEMBER_ERRORS } from '../src/member-facing/member-errors';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createClassTemplate,
  createMembership,
  createScheduledClass,
  createStudio,
  createUserWithPassword,
} from './helpers/factories';
import { getStudioLocalDateKey, studioLocalDateKeyToUtcAnchor } from '../src/common/date/studio-local-date';

/**
 * Day Pass purchase lifecycle end-to-end (real Postgres, Stripe HTTP mocked, real webhook
 * signature verification). Reproduces the production defect — abandon PaymentSheet, retry,
 * get "A Day Pass already exists for this date" — and proves the corrected state machine.
 */

const CUSTOMER = 'cus_e2e_test_customer';

function signed(payload: object, secret: string): { payloadString: string; header: string } {
  const payloadString = JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({ payload: payloadString, secret });
  return { payloadString, header };
}

type StripeMock = {
  retrievePrice: jest.Mock;
  createOrRetrieveCustomer: jest.Mock;
  createPaymentIntent: jest.Mock;
  retrievePaymentIntent: jest.Mock;
  cancelPaymentIntent: jest.Mock;
  createEphemeralKey: jest.Mock;
};

describe('Day Pass purchase lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: StripeMock;
  let webhookSecret: string;

  const todayKey = () => new Date().toISOString().slice(0, 10); // factory studios are UTC

  async function login(email: string, password: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function memberInStudio(email: string) {
    const studio = await createStudio(prisma);
    await prisma.studioDayPassSettings.create({
      data: {
        studioId: studio.id,
        displayName: 'Day Pass',
        priceCents: 20000,
        currency: 'mxn',
        active: true,
        stripeProductId: 'prod_e2e',
        stripePriceId: 'price_200',
      },
    });
    const member = await createUserWithPassword(prisma, { email, password: 'password12' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const token = await login(member.email, member.password);
    return { studio, member, token };
  }

  const purchase = (studioId: string, token: string, validForDate = todayKey()) =>
    request(app.getHttpServer())
      .post(`/api/v1/studios/${studioId}/day-passes/payment-sheet`)
      .set('Authorization', `Bearer ${token}`)
      .send({ validForDate });

  const sendWebhook = (event: object) => {
    const { payloadString, header } = signed(event, webhookSecret);
    return request(app.getHttpServer())
      .post('/api/v1/stripe/webhook')
      .set('Stripe-Signature', header)
      .set('Content-Type', 'application/json')
      .send(payloadString);
  };

  const piEvent = (type: string, id: string, pi: Record<string, unknown>) => ({
    id,
    type,
    data: { object: { object: 'payment_intent', ...pi } },
  });

  /** Makes Stripe "report" the slot's current intent in the given state. */
  async function stripeReports(dayPassId: string, status: string, overrides: Record<string, unknown> = {}) {
    const row = await prisma.dayPass.findUniqueOrThrow({ where: { id: dayPassId } });
    stripe.retrievePaymentIntent.mockResolvedValue({
      id: row.stripePaymentIntentId,
      object: 'payment_intent',
      status,
      amount: 20000,
      currency: 'mxn',
      customer: CUSTOMER,
      client_secret: `${row.stripePaymentIntentId}_secret`,
      created: Math.floor(Date.now() / 1000),
      metadata: { type: 'day_pass', dayPassId, studioId: row.studioId, userId: row.userId },
      ...overrides,
    });
    return row;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stripe = app.get(StripeService) as unknown as StripeMock;
    webhookSecret = app.get(ConfigService).getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    jest.clearAllMocks();
    // The checkout price resolver cross-checks the persisted Stripe Price before selling.
    stripe.retrievePrice.mockResolvedValue({
      id: 'price_200',
      object: 'price',
      unit_amount: 20000,
      currency: 'mxn',
      active: true,
      recurring: null,
      product: 'prod_e2e',
    });
    stripe.createOrRetrieveCustomer.mockResolvedValue({ id: CUSTOMER, object: 'customer' });
    stripe.createPaymentIntent.mockImplementation(async (params: { metadata: { attempt: string } }) => ({
      id: `pi_e2e_a${params.metadata.attempt}`,
      object: 'payment_intent',
      status: 'requires_payment_method',
      client_secret: `pi_e2e_a${params.metadata.attempt}_secret`,
    }));
    stripe.createEphemeralKey.mockResolvedValue({ secret: 'ek_secret' });
    stripe.cancelPaymentIntent.mockResolvedValue({ status: 'canceled' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('E1 REPRO + FIX: abandoning PaymentSheet then retrying re-presents the SAME intent — no 409, one row, one intent', async () => {
    const { studio, member, token } = await memberInStudio('e1@e2e.local');

    const first = await purchase(studio.id, token).expect(201);
    const { dayPassId } = first.body as { dayPassId: string };
    expect(first.body).toMatchObject({ paymentIntentClientSecret: 'pi_e2e_a1_secret', customerId: CUSTOMER });

    // Member closes the sheet without paying: Stripe still holds the intent in
    // requires_payment_method; the API was never told anything.
    await stripeReports(dayPassId, 'requires_payment_method');

    const retry = await purchase(studio.id, token).expect(201);
    expect((retry.body as { dayPassId: string }).dayPassId).toBe(dayPassId);
    expect((retry.body as { paymentIntentClientSecret: string }).paymentIntentClientSecret).toBe('pi_e2e_a1_secret');
    expect(JSON.stringify(retry.body)).not.toMatch(/already exists/i);

    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    const rows = await prisma.dayPass.findMany({ where: { studioId: studio.id, userId: member.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: DayPassStatus.PENDING, attemptCount: 2, stripePaymentIntentId: 'pi_e2e_a1' });
  });

  it('E2 an intent canceled at Stripe is replaced on retry; the old id stays in the slot history', async () => {
    const { studio, token } = await memberInStudio('e2@e2e.local');
    const { dayPassId } = (await purchase(studio.id, token).expect(201)).body as { dayPassId: string };
    await stripeReports(dayPassId, 'canceled');

    const retry = await purchase(studio.id, token).expect(201);
    expect((retry.body as { paymentIntentClientSecret: string }).paymentIntentClientSecret).toBe('pi_e2e_a2_secret');

    const row = await prisma.dayPass.findUniqueOrThrow({ where: { id: dayPassId } });
    expect(row.stripePaymentIntentId).toBe('pi_e2e_a2');
    expect(row.previousStripePaymentIntentIds).toEqual(['pi_e2e_a1']);
    expect(row.attemptCount).toBe(2);
    expect(await prisma.dayPass.count({ where: { studioId: studio.id } })).toBe(1);
  });

  it('E3 signed payment_intent.succeeded activates; replays are idempotent; then the day is truly owned (409 in Spanish, no internals)', async () => {
    const { studio, member, token } = await memberInStudio('e3@e2e.local');
    const { dayPassId } = (await purchase(studio.id, token).expect(201)).body as { dayPassId: string };

    const pi = {
      id: 'pi_e2e_a1',
      status: 'succeeded',
      amount: 20000,
      currency: 'mxn',
      customer: CUSTOMER,
      created: Math.floor(Date.now() / 1000),
      metadata: { type: 'day_pass', dayPassId, studioId: studio.id, userId: member.id },
    };
    await sendWebhook(piEvent('payment_intent.succeeded', 'evt_e3_1', pi)).expect(200);

    const activated = await prisma.dayPass.findUniqueOrThrow({ where: { id: dayPassId } });
    expect(activated.status).toBe(DayPassStatus.ACTIVE);
    expect(activated.activatedAt).not.toBeNull();
    expect(await prisma.payment.count({ where: { stripePaymentIntentId: 'pi_e2e_a1' } })).toBe(1);

    // Stripe retry of the same event id, and a second event for the same intent.
    await sendWebhook(piEvent('payment_intent.succeeded', 'evt_e3_1', pi)).expect(200);
    await sendWebhook(piEvent('payment_intent.succeeded', 'evt_e3_2', pi)).expect(200);
    expect(await prisma.payment.count({ where: { userId: member.id } })).toBe(1);
    expect(await prisma.dayPass.count({ where: { userId: member.id, status: DayPassStatus.ACTIVE } })).toBe(1);

    const mine = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/day-passes/me`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(mine.body).toHaveLength(1);
    expect((mine.body as Array<{ status: string }>)[0]?.status).toBe('ACTIVE');

    const again = await purchase(studio.id, token).expect(409);
    expect((again.body as { message: string }).message).toBe(MEMBER_ERRORS.dayPassAlreadyOwned);
    expect(JSON.stringify(again.body)).not.toMatch(/Prisma|P2002|already exists|Internal server error/i);
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('E4 open attempts are never listed as passes', async () => {
    const { studio, token } = await memberInStudio('e4@e2e.local');
    await purchase(studio.id, token).expect(201);
    const mine = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/day-passes/me`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(mine.body).toEqual([]);
  });

  it('E5 a card decline (payment_intent.payment_failed) is cached and the slot stays purchasable', async () => {
    const { studio, member, token } = await memberInStudio('e5@e2e.local');
    const { dayPassId } = (await purchase(studio.id, token).expect(201)).body as { dayPassId: string };

    await sendWebhook(
      piEvent('payment_intent.payment_failed', 'evt_e5_1', {
        id: 'pi_e2e_a1',
        status: 'requires_payment_method',
        amount: 20000,
        currency: 'mxn',
        created: Math.floor(Date.now() / 1000),
        metadata: { type: 'day_pass', dayPassId, studioId: studio.id, userId: member.id },
        last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'declined' },
      }),
    ).expect(200);

    const row = await prisma.dayPass.findUniqueOrThrow({ where: { id: dayPassId } });
    expect(row).toMatchObject({
      status: DayPassStatus.PENDING,
      lastStripeStatus: 'requires_payment_method',
      lastPaymentErrorCode: 'card_declined',
      lastPaymentDeclineCode: 'insufficient_funds',
    });
    expect(await prisma.payment.count({ where: { userId: member.id } })).toBe(0);

    await stripeReports(dayPassId, 'requires_payment_method');
    await purchase(studio.id, token).expect(201);
  });

  it('E6 post-payment sync asks Stripe, never the client: succeeded → ACTIVE + Payment; anything else → unchanged', async () => {
    const { studio, member, token } = await memberInStudio('e6@e2e.local');
    const { dayPassId } = (await purchase(studio.id, token).expect(201)).body as { dayPassId: string };

    await stripeReports(dayPassId, 'requires_action');
    const notYet = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/day-passes/${dayPassId}/sync`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((notYet.body as { status: string }).status).toBe('PENDING');
    expect(await prisma.payment.count({ where: { userId: member.id } })).toBe(0);

    await stripeReports(dayPassId, 'succeeded');
    const done = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/day-passes/${dayPassId}/sync`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((done.body as { status: string }).status).toBe('ACTIVE');
    expect(await prisma.payment.count({ where: { stripePaymentIntentId: 'pi_e2e_a1' } })).toBe(1);

    // Another member cannot sync (or even see) this pass.
    const other = await createUserWithPassword(prisma, { email: 'e6-other@e2e.local', password: 'password12' });
    await createMembership(prisma, other.id, studio.id, Role.MEMBER);
    const otherToken = await login(other.email, other.password);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/day-passes/${dayPassId}/sync`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
  });

  it('E7 retry after the payment already succeeded (webhook late) activates from Stripe and reports ownership', async () => {
    const { studio, member, token } = await memberInStudio('e7@e2e.local');
    const { dayPassId } = (await purchase(studio.id, token).expect(201)).body as { dayPassId: string };
    await stripeReports(dayPassId, 'succeeded');

    const res = await purchase(studio.id, token).expect(409);
    expect((res.body as { message: string }).message).toBe(MEMBER_ERRORS.dayPassAlreadyOwned);
    const row = await prisma.dayPass.findUniqueOrThrow({ where: { id: dayPassId } });
    expect(row.status).toBe(DayPassStatus.ACTIVE);
    expect(await prisma.payment.count({ where: { userId: member.id, stripePaymentIntentId: 'pi_e2e_a1' } })).toBe(1);
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('E8 double tap: concurrent purchases yield exactly one slot and at most one intent', async () => {
    const { studio, member, token } = await memberInStudio('e8@e2e.local');
    // Stripe reports whatever intent the slot currently holds, with the metadata the API set on it.
    stripe.retrievePaymentIntent.mockImplementation(async (id: string) => {
      const row = await prisma.dayPass.findUnique({ where: { stripePaymentIntentId: id } });
      return {
        id,
        status: 'requires_payment_method',
        amount: 20000,
        currency: 'mxn',
        customer: CUSTOMER,
        client_secret: `${id}_secret`,
        metadata: row ? { type: 'day_pass', dayPassId: row.id, studioId: row.studioId, userId: row.userId } : {},
      };
    });

    const results = await Promise.all([purchase(studio.id, token), purchase(studio.id, token), purchase(studio.id, token)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(statuses).toContain(201);
    for (const r of results.filter((x) => x.status === 409)) {
      expect((r.body as { message: string }).message).toBe(MEMBER_ERRORS.dayPassAttemptInProgress);
    }
    expect(await prisma.dayPass.count({ where: { studioId: studio.id, userId: member.id } })).toBe(1);
    expect(stripe.createPaymentIntent.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('E9 lapse sweep expires yesterday’s open attempt only; today’s attempt and purchased passes are untouched', async () => {
    const { studio, member } = await memberInStudio('e9@e2e.local');
    const day = (offset: number) => new Date(Date.UTC(2026, 0, 10 + offset));
    const mk = (validForDate: Date, status: DayPassStatus, pi: string) =>
      prisma.dayPass.create({
        data: { studioId: studio.id, userId: member.id, validForDate, priceCents: 20000, currency: 'mxn', status, stripePaymentIntentId: pi },
      });
    const stale = await mk(day(-1), DayPassStatus.PENDING, 'pi_stale');
    const paidPast = await mk(day(-2), DayPassStatus.ACTIVE, 'pi_paid');
    const open = await mk(day(0), DayPassStatus.PENDING, 'pi_open');

    stripe.retrievePaymentIntent.mockImplementation(async (id: string) => ({ id, status: 'requires_payment_method', amount: 20000, currency: 'mxn', metadata: {} }));
    const sweep = await app.get(DayPassAttemptSweepService).expireLapsedAttempts(new Date(Date.UTC(2026, 0, 10, 12)));
    expect(sweep).toEqual({ expired: 1, activated: 0, deferred: 0 });
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect((await prisma.dayPass.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe(DayPassStatus.EXPIRED);
    expect((await prisma.dayPass.findUniqueOrThrow({ where: { id: paidPast.id } })).status).toBe(DayPassStatus.ACTIVE);
    expect((await prisma.dayPass.findUniqueOrThrow({ where: { id: open.id } })).status).toBe(DayPassStatus.PENDING);
    expect((await app.get(DayPassAttemptSweepService).expireLapsedAttempts(new Date(Date.UTC(2026, 0, 10, 13)))).expired).toBe(0);
  });

  it('E9b the sweep activates (never expires) a lapsed attempt that Stripe reports paid', async () => {
    const { studio, member } = await memberInStudio('e9b@e2e.local');
    const row = await prisma.dayPass.create({
      data: { studioId: studio.id, userId: member.id, validForDate: new Date(Date.UTC(2026, 0, 9)), priceCents: 20000, currency: 'mxn', status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_paid_late' },
    });
    stripe.retrievePaymentIntent.mockResolvedValue({
      id: 'pi_paid_late', status: 'succeeded', amount: 20000, currency: 'mxn', created: Math.floor(Date.now() / 1000),
      metadata: { type: 'day_pass', dayPassId: row.id, studioId: studio.id, userId: member.id },
    });

    const sweep = await app.get(DayPassAttemptSweepService).expireLapsedAttempts(new Date(Date.UTC(2026, 0, 10, 12)));
    expect(sweep).toEqual({ expired: 0, activated: 1, deferred: 0 });
    expect((await prisma.dayPass.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(DayPassStatus.ACTIVE);
    expect(await prisma.payment.count({ where: { stripePaymentIntentId: 'pi_paid_late' } })).toBe(1);
  });

  it('E11 NEW client body {} → the SERVER picks today in the studio timezone', async () => {
    const { studio, member, token } = await memberInStudio('e11@e2e.local');
    await prisma.studio.update({ where: { id: studio.id }, data: { timezone: 'America/Mexico_City' } });

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/day-passes/payment-sheet`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);

    const row = await prisma.dayPass.findFirstOrThrow({ where: { studioId: studio.id, userId: member.id } });
    const todayMx = getStudioLocalDateKey(new Date(), 'America/Mexico_City');
    expect(row.validForDate.toISOString()).toBe(studioLocalDateKeyToUtcAnchor(todayMx, 'America/Mexico_City').toISOString());
    const [params] = stripe.createPaymentIntent.mock.calls[0] as [{ metadata: Record<string, string> }];
    expect(params.metadata.validForDate).toBe(todayMx);
  });

  it('E12 a LEGACY-shaped ACTIVE pass (pre-migration row, defaults only) still books an eligible class and blocks a re-purchase', async () => {
    const { studio, member, token } = await memberInStudio('e12@e2e.local');
    const tpl = await createClassTemplate(prisma, studio.id, { name: 'Funcional' });
    await prisma.dayPassClassAccess.create({ data: { studioId: studio.id, classTemplateId: tpl.id } });
    const startsAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    });
    const classDay = getStudioLocalDateKey(startsAt, 'UTC');
    // Written with ONLY the pre-migration columns, exactly like the 8 production ACTIVE rows.
    await prisma.$executeRaw`
      INSERT INTO day_passes (id, studio_id, user_id, valid_for_date, price_cents, currency, status, stripe_payment_intent_id, updated_at)
      VALUES ('legacy_active_e12', ${studio.id}, ${member.id}, ${studioLocalDateKeyToUtcAnchor(classDay, 'UTC')}, 20000, 'mxn', 'ACTIVE', 'pi_legacy_e12', now())`;

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const legacy = await prisma.dayPass.findUniqueOrThrow({ where: { id: 'legacy_active_e12' } });
    expect(legacy).toMatchObject({ status: DayPassStatus.ACTIVE, attemptCount: 1, previousStripePaymentIntentIds: [], activatedAt: null });

    const again = await purchase(studio.id, token, classDay).expect(409);
    expect((again.body as { message: string }).message).toBe(MEMBER_ERRORS.dayPassAlreadyOwned);
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    const unchanged = await prisma.dayPass.findUniqueOrThrow({ where: { id: 'legacy_active_e12' } });
    expect(unchanged.updatedAt.toISOString()).toBe(legacy.updatedAt.toISOString());
  });

  it('E10 a past date is refused in Spanish and creates nothing', async () => {
    const { studio, token } = await memberInStudio('e10@e2e.local');
    const res = await purchase(studio.id, token, '2020-01-01').expect(400);
    expect((res.body as { message: string }).message).toBe(MEMBER_ERRORS.dayPassDateInPast);
    expect(await prisma.dayPass.count({ where: { studioId: studio.id } })).toBe(0);
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });
});
