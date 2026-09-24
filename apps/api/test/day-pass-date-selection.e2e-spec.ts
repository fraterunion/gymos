import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DayPassStatus, Role } from '@prisma/client';
import Stripe from 'stripe';
import request from 'supertest';
import { addDaysToDateKey, getStudioLocalDateKey, studioLocalDateKeyToUtcAnchor } from '../src/common/date/studio-local-date';
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

/**
 * Member-chosen Day Pass dates (real Postgres, Stripe HTTP mocked, real webhook signatures).
 * The studio is America/Mexico_City so the UTC calendar day and the studio day disagree for
 * six hours every night; every "today" below is the STUDIO's today.
 */

const CUSTOMER = 'cus_e2e_test_customer';
const TZ = 'America/Mexico_City';

type StripeMock = {
  retrievePrice: jest.Mock;
  createOrRetrieveCustomer: jest.Mock;
  createPaymentIntent: jest.Mock;
  retrievePaymentIntent: jest.Mock;
  cancelPaymentIntent: jest.Mock;
  createEphemeralKey: jest.Mock;
};

function signed(payload: object, secret: string) {
  const payloadString = JSON.stringify(payload);
  return { payloadString, header: Stripe.webhooks.generateTestHeaderString({ payload: payloadString, secret }) };
}

describe('Day Pass — member-chosen date (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: StripeMock;
  let webhookSecret: string;
  let intentSeq = 0;

  const today = () => getStudioLocalDateKey(new Date(), TZ);
  const plus = (n: number) => addDaysToDateKey(today(), n);

  async function login(email: string, password: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function memberInStudio(email: string) {
    const studio = await createStudio(prisma, { timezone: TZ });
    await prisma.studioDayPassSettings.create({
      data: { studioId: studio.id, displayName: 'Day Pass', priceCents: 25000, currency: 'mxn', active: true, stripeProductId: 'prod_e2e', stripePriceId: 'price_250' },
    });
    const member = await createUserWithPassword(prisma, { email, password: 'password12' });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    return { studio, member, token: await login(member.email, member.password) };
  }

  const purchase = (studioId: string, token: string, body: object) =>
    request(app.getHttpServer()).post(`/api/v1/studios/${studioId}/day-passes/payment-sheet`).set('Authorization', `Bearer ${token}`).send(body);

  const listMine = (studioId: string, token: string, scope?: string) =>
    request(app.getHttpServer()).get(`/api/v1/studios/${studioId}/day-passes/me${scope ? `?scope=${scope}` : ''}`).set('Authorization', `Bearer ${token}`);

  const succeededWebhook = async (dayPassId: string, studioId: string, userId: string, validForDate: string, eventId: string) => {
    const row = await prisma.dayPass.findUniqueOrThrow({ where: { id: dayPassId } });
    const event = {
      id: eventId,
      type: 'payment_intent.succeeded',
      data: { object: { object: 'payment_intent', id: row.stripePaymentIntentId, status: 'succeeded', amount: 25000, currency: 'mxn', customer: CUSTOMER, created: Math.floor(Date.now() / 1000), metadata: { type: 'day_pass', dayPassId, studioId, userId, validForDate } } },
    };
    const { payloadString, header } = signed(event, webhookSecret);
    return request(app.getHttpServer()).post('/api/v1/stripe/webhook').set('Stripe-Signature', header).set('Content-Type', 'application/json').send(payloadString).expect(200);
  };

  /** Stripe reports the slot's current intent in the given state, with the metadata the API set. */
  function stripeReportsCurrentIntents(status: string) {
    stripe.retrievePaymentIntent.mockImplementation(async (id: string) => {
      const row = await prisma.dayPass.findUnique({ where: { stripePaymentIntentId: id } });
      return {
        id, object: 'payment_intent', status, amount: 25000, currency: 'mxn', customer: CUSTOMER, client_secret: `${id}_secret`, created: Math.floor(Date.now() / 1000),
        metadata: row ? { type: 'day_pass', dayPassId: row.id, studioId: row.studioId, userId: row.userId, validForDate: getStudioLocalDateKey(row.validForDate, TZ) } : {},
      };
    });
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
    intentSeq = 0;
    stripe.retrievePrice.mockResolvedValue({ id: 'price_250', object: 'price', unit_amount: 25000, currency: 'mxn', active: true, recurring: null, product: 'prod_e2e' });
    stripe.createOrRetrieveCustomer.mockResolvedValue({ id: CUSTOMER, object: 'customer' });
    stripe.createPaymentIntent.mockImplementation(async () => {
      const id = `pi_e2e_${++intentSeq}`;
      return { id, object: 'payment_intent', status: 'requires_payment_method', client_secret: `${id}_secret` };
    });
    stripe.createEphemeralKey.mockResolvedValue({ secret: 'ek_secret' });
    stripe.cancelPaymentIntent.mockResolvedValue({ status: 'canceled' });
    stripeReportsCurrentIntents('requires_payment_method');
  });

  afterAll(async () => {
    await app.close();
  });

  it('D1 purchase-window: studio-local today, today+30 horizon, and owned days inside the window', async () => {
    const { studio, member, token } = await memberInStudio('d1@e2e.local');
    await prisma.dayPass.create({ data: { studioId: studio.id, userId: member.id, validForDate: studioLocalDateKeyToUtcAnchor(plus(2), TZ), priceCents: 25000, currency: 'mxn', status: DayPassStatus.ACTIVE, stripePaymentIntentId: 'pi_owned' } });
    await prisma.dayPass.create({ data: { studioId: studio.id, userId: member.id, validForDate: studioLocalDateKeyToUtcAnchor(plus(-1), TZ), priceCents: 25000, currency: 'mxn', status: DayPassStatus.ACTIVE, stripePaymentIntentId: 'pi_past' } });
    await prisma.dayPass.create({ data: { studioId: studio.id, userId: member.id, validForDate: studioLocalDateKeyToUtcAnchor(plus(5), TZ), priceCents: 25000, currency: 'mxn', status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_open' } });

    const res = await request(app.getHttpServer()).get(`/api/v1/studios/${studio.id}/day-passes/purchase-window`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toEqual({ timezone: TZ, todayKey: today(), maxDateKey: plus(30), horizonDays: 30, ownedDateKeys: [plus(2)] });
  });

  it('D2 accepted days: today, tomorrow, today+30; rejected: past, +31, malformed — all Spanish, nothing minted', async () => {
    const { studio, token } = await memberInStudio('d2@e2e.local');
    for (const ok of [today(), plus(1), plus(30)]) {
      const r = await purchase(studio.id, token, { validForDate: ok }).expect(201);
      expect((r.body as { validForDate: string }).validForDate).toBe(ok);
    }
    const past = await purchase(studio.id, token, { validForDate: plus(-1) }).expect(400);
    expect((past.body as { message: string }).message).toBe(MEMBER_ERRORS.dayPassDateInPast);
    const far = await purchase(studio.id, token, { validForDate: plus(31) }).expect(400);
    expect((far.body as { message: string }).message).toBe(MEMBER_ERRORS.dayPassDateBeyondHorizon);
    const bad = await purchase(studio.id, token, { validForDate: '2026-13-01' }).expect(400);
    expect((bad.body as { message: string }).message).toBe(MEMBER_ERRORS.dayPassDateInvalid);
    const shape = await purchase(studio.id, token, { validForDate: '2026-9-3' }).expect(400);
    expect(JSON.stringify(shape.body)).not.toMatch(/Prisma|Internal|YYYY/i);
    expect(JSON.stringify(shape.body)).toContain(MEMBER_ERRORS.dayPassDateInvalid);
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(3);
    expect(await prisma.dayPass.count({ where: { studioId: studio.id } })).toBe(3);
  });

  it('D3 legacy client omits the date → studio-local today (server authority)', async () => {
    const { studio, member, token } = await memberInStudio('d3@e2e.local');
    const r = await purchase(studio.id, token, {}).expect(201);
    expect((r.body as { validForDate: string }).validForDate).toBe(today());
    const row = await prisma.dayPass.findFirstOrThrow({ where: { studioId: studio.id, userId: member.id } });
    expect(row.validForDate.toISOString()).toBe(studioLocalDateKeyToUtcAnchor(today(), TZ).toISOString());
  });

  it('D4 scenario A: buy Sep 24 then Sep 25 → two independent ACTIVE passes, listed upcoming soonest-first', async () => {
    const { studio, member, token } = await memberInStudio('d4@e2e.local');
    const a = (await purchase(studio.id, token, { validForDate: plus(1) }).expect(201)).body as { dayPassId: string };
    const b = (await purchase(studio.id, token, { validForDate: plus(2) }).expect(201)).body as { dayPassId: string };
    expect(a.dayPassId).not.toBe(b.dayPassId);
    await succeededWebhook(a.dayPassId, studio.id, member.id, plus(1), 'evt_d4_a');
    await succeededWebhook(b.dayPassId, studio.id, member.id, plus(2), 'evt_d4_b');

    const upcoming = await listMine(studio.id, token, 'upcoming').expect(200);
    expect((upcoming.body as Array<{ validForDateKey: string; status: string; relativeDay: string }>).map((p) => [p.validForDateKey, p.status, p.relativeDay])).toEqual([[plus(1), 'ACTIVE', 'upcoming'], [plus(2), 'ACTIVE', 'upcoming']]);
    expect(await prisma.payment.count({ where: { userId: member.id } })).toBe(2);
  });

  it('D5 scenario B: ACTIVE Sep 24 + buy Sep 24 → blocked in Spanish before any intent; Sep 25 still allowed (scenario A/D)', async () => {
    const { studio, member, token } = await memberInStudio('d5@e2e.local');
    const a = (await purchase(studio.id, token, { validForDate: plus(1) }).expect(201)).body as { dayPassId: string };
    await succeededWebhook(a.dayPassId, studio.id, member.id, plus(1), 'evt_d5');
    stripe.createPaymentIntent.mockClear();

    const dup = await purchase(studio.id, token, { validForDate: plus(1) }).expect(409);
    expect((dup.body as { message: string }).message).toBe(MEMBER_ERRORS.dayPassAlreadyOwned);
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();

    await purchase(studio.id, token, { validForDate: plus(2) }).expect(201);
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('D6 scenarios C+D+E: abandon Sep 24, buy Sep 25, then Sep 24 pays late → ONLY Sep 24 activates; Sep 24 stays retryable', async () => {
    const { studio, member, token } = await memberInStudio('d6@e2e.local');
    const sep24 = (await purchase(studio.id, token, { validForDate: plus(1) }).expect(201)).body as { dayPassId: string; paymentIntentClientSecret: string };
    // member cancels the sheet, changes their mind, buys Sep 25 instead
    const sep25 = (await purchase(studio.id, token, { validForDate: plus(2) }).expect(201)).body as { dayPassId: string; paymentIntentClientSecret: string };
    expect(sep25.dayPassId).not.toBe(sep24.dayPassId);
    expect(sep25.paymentIntentClientSecret).not.toBe(sep24.paymentIntentClientSecret); // no cross-date intent reuse
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(2);

    // the Sep 24 intent succeeds after all (3DS finished later)
    await succeededWebhook(sep24.dayPassId, studio.id, member.id, plus(1), 'evt_d6_24');
    const rows = await prisma.dayPass.findMany({ where: { studioId: studio.id, userId: member.id }, orderBy: { validForDate: 'asc' } });
    expect(rows.map((r) => [getStudioLocalDateKey(r.validForDate, TZ), r.status])).toEqual([[plus(1), DayPassStatus.ACTIVE], [plus(2), DayPassStatus.PENDING]]);

    // Sep 25 retry re-presents ITS OWN intent (scenario C on the other date)
    const retry = await purchase(studio.id, token, { validForDate: plus(2) }).expect(201);
    expect((retry.body as { dayPassId: string; paymentIntentClientSecret: string }).dayPassId).toBe(sep25.dayPassId);
    expect((retry.body as { paymentIntentClientSecret: string }).paymentIntentClientSecret).toBe(sep25.paymentIntentClientSecret);
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(2);
  });

  it('D7 a Sep 24 intent can never activate Sep 25 (webhook correlation is per slot, and the slot is per day)', async () => {
    const { studio, member, token } = await memberInStudio('d7@e2e.local');
    const sep24 = (await purchase(studio.id, token, { validForDate: plus(1) }).expect(201)).body as { dayPassId: string };
    const sep25 = (await purchase(studio.id, token, { validForDate: plus(2) }).expect(201)).body as { dayPassId: string };
    const row24 = await prisma.dayPass.findUniqueOrThrow({ where: { id: sep24.dayPassId } });
    // A forged/mis-routed success: Sep 24's intent id but Sep 25's dayPassId in metadata.
    const event = { id: 'evt_d7_cross', type: 'payment_intent.succeeded', data: { object: { object: 'payment_intent', id: row24.stripePaymentIntentId, status: 'succeeded', amount: 25000, currency: 'mxn', created: Math.floor(Date.now() / 1000), metadata: { type: 'day_pass', dayPassId: sep25.dayPassId, studioId: studio.id, userId: member.id, validForDate: plus(2) } } } };
    const { payloadString, header } = signed(event, webhookSecret);
    await request(app.getHttpServer()).post('/api/v1/stripe/webhook').set('Stripe-Signature', header).set('Content-Type', 'application/json').send(payloadString).expect(200);

    const rows = await prisma.dayPass.findMany({ where: { studioId: studio.id, userId: member.id } });
    expect(rows.every((r) => r.status === DayPassStatus.PENDING)).toBe(true);
    expect(await prisma.payment.count({ where: { userId: member.id } })).toBe(0);
  });

  it('D8 concurrency: same member, two DIFFERENT days at once → both allowed; same day at once → one slot', async () => {
    const { studio, member, token } = await memberInStudio('d8@e2e.local');
    const diff = await Promise.all([purchase(studio.id, token, { validForDate: plus(3) }), purchase(studio.id, token, { validForDate: plus(4) })]);
    expect(diff.map((r) => r.status)).toEqual([201, 201]);
    const same = await Promise.all([purchase(studio.id, token, { validForDate: plus(5) }), purchase(studio.id, token, { validForDate: plus(5) }), purchase(studio.id, token, { validForDate: plus(5) })]);
    expect(same.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(same.some((r) => r.status === 201)).toBe(true);
    expect(await prisma.dayPass.count({ where: { studioId: studio.id, userId: member.id } })).toBe(3);
  });

  it('D9 entitlement: a FUTURE ACTIVE pass grants nothing today; it grants access on its own day only (scenario F)', async () => {
    const { studio, member, token } = await memberInStudio('d9@e2e.local');
    const tpl = await createClassTemplate(prisma, studio.id, { name: 'Funcional' });
    await prisma.dayPassClassAccess.create({ data: { studioId: studio.id, classTemplateId: tpl.id } });
    // Pass for today+2 (studio day).
    await prisma.dayPass.create({ data: { studioId: studio.id, userId: member.id, validForDate: studioLocalDateKeyToUtcAnchor(plus(2), TZ), priceCents: 25000, currency: 'mxn', status: DayPassStatus.ACTIVE, stripePaymentIntentId: 'pi_future' } });
    const classAt = (dayKey: string) => {
      const start = new Date(studioLocalDateKeyToUtcAnchor(dayKey, TZ).getTime() + 18 * 3600_000); // 12:00 studio-local
      return createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: new Date(start.getTime() + 3600_000) });
    };
    const tomorrow = await classAt(plus(1));
    const target = await classAt(plus(2));
    const dayAfter = await classAt(plus(3));

    const noToday = await request(app.getHttpServer()).post(`/api/v1/studios/${studio.id}/classes/${tomorrow.id}/bookings`).set('Authorization', `Bearer ${token}`).expect(403);
    expect((noToday.body as { message: string }).message).toBe(MEMBER_ERRORS.membershipOrDayPassRequired);
    await request(app.getHttpServer()).post(`/api/v1/studios/${studio.id}/classes/${target.id}/bookings`).set('Authorization', `Bearer ${token}`).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/studios/${studio.id}/classes/${dayAfter.id}/bookings`).set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('D10 studio clock beats the device clock: the day is validated on the studio timezone whatever the caller sends', async () => {
    const { studio, member, token } = await memberInStudio('d10@e2e.local');
    // A device on UTC or Asia/Tokyo may "see" a later calendar day than the studio. Whatever key
    // it sends, the server compares it to the STUDIO's today: yesterday-in-studio is rejected,
    // any key inside [today, today+30] in studio terms is stored on the studio anchor.
    const yesterdayStudio = plus(-1);
    const r1 = await purchase(studio.id, token, { validForDate: yesterdayStudio }).expect(400);
    expect((r1.body as { message: string }).message).toBe(MEMBER_ERRORS.dayPassDateInPast);
    const r2 = await purchase(studio.id, token, { validForDate: plus(1) }).expect(201);
    expect((r2.body as { validForDate: string }).validForDate).toBe(plus(1));
    const row = await prisma.dayPass.findFirstOrThrow({ where: { studioId: studio.id, userId: member.id } });
    expect(row.validForDate.toISOString()).toBe(studioLocalDateKeyToUtcAnchor(plus(1), TZ).toISOString());
    expect(row.validForDate.getUTCHours()).toBe(6); // Mexico City midnight = 06:00Z
  });

  it('D11 sync after payment returns the purchased day; list(all) keeps legacy newest-first order with the new fields', async () => {
    const { studio, member, token } = await memberInStudio('d11@e2e.local');
    const b = (await purchase(studio.id, token, { validForDate: plus(6) }).expect(201)).body as { dayPassId: string };
    stripeReportsCurrentIntents('succeeded');
    const sync = await request(app.getHttpServer()).post(`/api/v1/studios/${studio.id}/day-passes/${b.dayPassId}/sync`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(sync.body).toMatchObject({ status: 'ACTIVE', validForDateKey: plus(6), relativeDay: 'upcoming' });

    await prisma.dayPass.create({ data: { studioId: studio.id, userId: member.id, validForDate: studioLocalDateKeyToUtcAnchor(plus(-3), TZ), priceCents: 25000, currency: 'mxn', status: DayPassStatus.ACTIVE, stripePaymentIntentId: 'pi_hist' } });
    const all = await listMine(studio.id, token).expect(200);
    expect((all.body as Array<{ validForDateKey: string; relativeDay: string }>).map((p) => [p.validForDateKey, p.relativeDay])).toEqual([[plus(6), 'upcoming'], [plus(-3), 'past']]);
    const history = await listMine(studio.id, token, 'history').expect(200);
    expect((history.body as Array<{ validForDateKey: string }>).map((p) => p.validForDateKey)).toEqual([plus(-3)]);
    await listMine(studio.id, token, 'bogus').expect(400);
  });
});
