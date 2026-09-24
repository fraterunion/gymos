import { BadRequestException, ConflictException } from '@nestjs/common';
import { DayPassStatus, Prisma } from '@prisma/client';
import { addDaysToDateKey, getStudioLocalDateKey, studioLocalDateKeyToUtcAnchor } from '../common/date/studio-local-date';
import { MEMBER_ERRORS } from '../member-facing/member-errors';
import { DayPassesService, IN_FLIGHT_GRACE_MS } from './day-passes.service';

/**
 * Purchase lifecycle rules. Every test pins one invariant from the state machine:
 * an attempt is not ownership, retries reuse or replace the intent, Stripe is the authority,
 * and nothing here can double-charge or grant without Stripe success.
 */

const TZ = 'America/Mexico_City';
const STUDIO = 'studio-1';
const USER = 'user-1';
const CUSTOMER = 'cus_1';
const PRICE = 25000;

function todayKey(): string {
  return getStudioLocalDateKey(new Date(), TZ);
}

function representablePi(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_old',
    status: 'requires_payment_method',
    amount: PRICE,
    currency: 'mxn',
    customer: CUSTOMER,
    client_secret: 'pi_old_secret',
    created: 1_700_000_000,
    metadata: { type: 'day_pass', dayPassId: 'dp_1', studioId: STUDIO, userId: USER },
    ...overrides,
  };
}

function slot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dp_1',
    status: DayPassStatus.PENDING,
    priceCents: PRICE,
    currency: 'mxn',
    stripePaymentIntentId: 'pi_old',
    attemptCount: 1,
    lastAttemptAt: new Date(Date.now() - 10 * 60_000),
    createdAt: new Date(Date.now() - 10 * 60_000),
    ...overrides,
  };
}

describe('DayPassesService — purchase lifecycle', () => {
  const prisma = {
    studio: { findFirst: jest.fn() },
    user: { findFirst: jest.fn(), update: jest.fn() },
    dayPass: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    payment: { upsert: jest.fn(), findUnique: jest.fn() },
  };
  const stripe = {
    createOrRetrieveCustomer: jest.fn(),
    createPaymentIntent: jest.fn(),
    retrievePaymentIntent: jest.fn(),
    cancelPaymentIntent: jest.fn(),
    createEphemeralKey: jest.fn(),
  };
  const config = { getOrThrow: jest.fn(() => 'pk_test_123') };
  const waiver = { assertMemberWaiverAccepted: jest.fn() };
  const settings = { resolveCheckoutSalePrice: jest.fn() };

  const service = new DayPassesService(
    prisma as never,
    stripe as never,
    config as never,
    waiver as never,
    settings as never,
  );

  const purchase = () =>
    service.createDayPassPaymentSheet({ studioId: STUDIO, userId: USER, validForDate: todayKey() });

  beforeEach(() => {
    jest.resetAllMocks();
    config.getOrThrow.mockReturnValue('pk_test_123');
    prisma.payment.findUnique.mockResolvedValue(null);
    waiver.assertMemberWaiverAccepted.mockResolvedValue(undefined);
    settings.resolveCheckoutSalePrice.mockResolvedValue({
      priceCents: PRICE,
      currency: 'mxn',
      stripePriceId: 'price_day_pass',
      settings: {},
    });
    prisma.studio.findFirst.mockResolvedValue({ id: STUDIO, timezone: TZ });
    prisma.user.findFirst.mockResolvedValue({
      id: USER,
      email: 'm@example.com',
      firstName: 'M',
      lastName: 'X',
      stripeCustomerId: CUSTOMER,
    });
    stripe.createOrRetrieveCustomer.mockResolvedValue({ id: CUSTOMER });
    stripe.createPaymentIntent.mockImplementation(async (params: { metadata: { attempt: string } }) => ({
      id: `pi_new_${params.metadata.attempt}`,
      status: 'requires_payment_method',
      client_secret: `pi_new_${params.metadata.attempt}_secret`,
    }));
    stripe.createEphemeralKey.mockResolvedValue({ secret: 'ek_secret' });
    stripe.cancelPaymentIntent.mockResolvedValue({ status: 'canceled' });
    prisma.dayPass.create.mockResolvedValue({ id: 'dp_1' });
    prisma.dayPass.update.mockResolvedValue({});
    prisma.dayPass.updateMany.mockResolvedValue({ count: 1 });
    prisma.dayPass.deleteMany.mockResolvedValue({ count: 1 });
    prisma.payment.upsert.mockResolvedValue({});
  });

  it('T1 first purchase: creates a PENDING attempt slot, then an intent with an idempotency key', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(null);

    const res = await purchase();

    expect(prisma.dayPass.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          studioId: STUDIO,
          userId: USER,
          validForDate: studioLocalDateKeyToUtcAnchor(todayKey(), TZ),
          status: DayPassStatus.PENDING,
          attemptCount: 1,
        }),
      }),
    );
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    const [params, options] = stripe.createPaymentIntent.mock.calls[0] as [
      { amount: number; currency: string; customer: string; metadata: Record<string, string> },
      { idempotencyKey: string },
    ];
    expect(params.amount).toBe(PRICE);
    expect(params.currency).toBe('mxn');
    expect(params.customer).toBe(CUSTOMER);
    expect(params.metadata).toEqual(
      expect.objectContaining({ type: 'day_pass', dayPassId: 'dp_1', studioId: STUDIO, userId: USER, attempt: '1' }),
    );
    expect(options.idempotencyKey).toBe(`day_pass:dp_1:a1:${PRICE}:mxn`);
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith({
      where: { id: 'dp_1', stripePaymentIntentId: null },
      data: { stripePaymentIntentId: 'pi_new_1', lastStripeStatus: 'requires_payment_method' },
    });
    expect(res).toEqual({
      dayPassId: 'dp_1',
      validForDate: todayKey(),
      paymentIntentClientSecret: 'pi_new_1_secret',
      customerId: CUSTOMER,
      ephemeralKeySecret: 'ek_secret',
      publishableKey: 'pk_test_123',
    });
  });

  it('T2 an ACTIVE pass for the day is real ownership: 409 in Spanish, no Stripe call', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot({ status: DayPassStatus.ACTIVE }));

    await expect(purchase()).rejects.toMatchObject({
      constructor: ConflictException,
      message: MEMBER_ERRORS.dayPassAlreadyOwned,
    });
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('T3 abandoned attempt (intent still requires_payment_method): retry RE-PRESENTS the same intent, no 409, no new intent', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot());
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi());

    const res = await purchase();

    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(res.paymentIntentClientSecret).toBe('pi_old_secret');
    expect(res.dayPassId).toBe('dp_1');
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dp_1', status: { not: DayPassStatus.ACTIVE }, stripePaymentIntentId: 'pi_old', attemptCount: 1 },
        data: expect.objectContaining({ status: DayPassStatus.PENDING, attemptCount: 2 }),
      }),
    );
  });

  it('T3b a 3DS challenge left mid-way (requires_action) is cancelled and replaced, never re-presented', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot());
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ status: 'requires_action' }));

    const res = await purchase();

    expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_old', 'abandoned');
    expect(res.paymentIntentClientSecret).toBe('pi_new_2_secret');
  });

  it('T3d cancel before replace FAILS because the member just paid it → activate from Stripe, 409 owned, NO second intent', async () => {
    prisma.dayPass.findUnique
      .mockResolvedValueOnce(slot()) // slot lookup
      .mockResolvedValueOnce({
        id: 'dp_1', studioId: STUDIO, userId: USER, status: DayPassStatus.PENDING, priceCents: PRICE, currency: 'mxn',
        stripePaymentIntentId: 'pi_old', previousStripePaymentIntentIds: [], studio: { timezone: 'America/Mexico_City' }, validForDate: studioLocalDateKeyToUtcAnchor(todayKey(), TZ),
      });
    stripe.retrievePaymentIntent
      .mockResolvedValueOnce(representablePi({ status: 'requires_action' }))
      .mockResolvedValueOnce(representablePi({ status: 'succeeded' }));
    stripe.cancelPaymentIntent.mockRejectedValue(Object.assign(new Error('unexpected state'), { code: 'payment_intent_unexpected_state' }));

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassAlreadyOwned });
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(prisma.payment.upsert).toHaveBeenCalledTimes(1);
  });

  it('T3e cancel before replace fails transiently and the intent is still payable → 409 in progress, NO second intent', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot());
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ status: 'requires_action' }));
    stripe.cancelPaymentIntent.mockRejectedValue(Object.assign(new Error('rate limited'), { code: 'rate_limit' }));

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassAttemptInProgress });
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    // Only the attempt reservation was written; the intent binding was never touched.
    expect(prisma.dayPass.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { attemptCount: 2, lastAttemptAt: expect.any(Date) } }));
  });

  it('T3c CAS: the member paid the intent between our Stripe read and our write → no downgrade, 409 owned', async () => {
    prisma.dayPass.findUnique
      .mockResolvedValueOnce(slot())
      .mockResolvedValueOnce({ status: DayPassStatus.ACTIVE, stripePaymentIntentId: 'pi_old' }); // fresh read after the CAS misses
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi());
    prisma.dayPass.updateMany.mockResolvedValue({ count: 0 });

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassAlreadyOwned });
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('T4 intent canceled at Stripe: retry REPLACES it, keeping the old id in the slot history', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot());
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ status: 'canceled' }));

    const res = await purchase();

    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect((stripe.createPaymentIntent.mock.calls[0] as unknown[])[1]).toEqual({
      idempotencyKey: `day_pass:dp_1:a2:${PRICE}:mxn`,
    });
    // 1) attempt number reserved BEFORE Stripe is called, 2) intent bound with a CAS on it.
    expect(prisma.dayPass.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'dp_1', status: { not: DayPassStatus.ACTIVE }, stripePaymentIntentId: 'pi_old', attemptCount: 1 },
      data: { attemptCount: 2, lastAttemptAt: expect.any(Date) },
    });
    expect(prisma.dayPass.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'dp_1', status: { not: DayPassStatus.ACTIVE }, stripePaymentIntentId: 'pi_old', attemptCount: 2 },
        data: expect.objectContaining({
          stripePaymentIntentId: 'pi_new_2',
          previousStripePaymentIntentIds: { push: 'pi_old' },
          attemptCount: 2,
          status: DayPassStatus.PENDING,
        }),
      }),
    );
    expect(stripe.createPaymentIntent.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.dayPass.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(res.paymentIntentClientSecret).toBe('pi_new_2_secret');
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it('T4b CAS on replace: if the slot moved under us, the freshly minted intent is cancelled and nothing is overwritten', async () => {
    prisma.dayPass.findUnique
      .mockResolvedValueOnce(slot())
      .mockResolvedValueOnce({ status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_someone_elses' });
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ status: 'canceled' }));
    prisma.dayPass.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassAttemptInProgress });
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_new_2', 'duplicate');
  });

  it('T4d a Stripe failure while creating the replacement BURNS that attempt number: the next retry uses a new idempotency key', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot());
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ status: 'canceled' }));
    stripe.createPaymentIntent.mockRejectedValueOnce(Object.assign(new Error('stripe 500'), { statusCode: 500 }));

    await expect(purchase()).rejects.toThrow('stripe 500');
    expect(prisma.dayPass.updateMany).toHaveBeenCalledTimes(1); // the reservation, persisted before Stripe
    expect((stripe.createPaymentIntent.mock.calls[0] as unknown[])[1]).toEqual({ idempotencyKey: `day_pass:dp_1:a2:${PRICE}:mxn` });

    // Next tap sees the reserved attempt number (2) and therefore uses a3 — never the poisoned a2.
    prisma.dayPass.findUnique.mockResolvedValue(slot({ attemptCount: 2 }));
    const res = await purchase();
    expect((stripe.createPaymentIntent.mock.calls[1] as unknown[])[1]).toEqual({ idempotencyKey: `day_pass:dp_1:a3:${PRICE}:mxn` });
    expect(res.paymentIntentClientSecret).toBe('pi_new_3_secret');
  });

  it('T4f reserve BEFORE retire: a replacer that loses the reservation cancels nothing (a concurrent reuse keeps a live intent)', async () => {
    prisma.dayPass.findUnique
      .mockResolvedValueOnce(slot({ priceCents: 20000 }))
      .mockResolvedValueOnce({ status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_old' });
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ amount: 20000 })); // stale → would retire
    prisma.dayPass.updateMany.mockResolvedValueOnce({ count: 0 }); // a concurrent reuse moved attemptCount

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassAttemptInProgress });
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('T4g requires_action: the reservation happens before the Stripe cancel', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot());
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ status: 'requires_action' }));

    await purchase();

    expect(prisma.dayPass.updateMany.mock.invocationCallOrder[0]).toBeLessThan(stripe.cancelPaymentIntent.mock.invocationCallOrder[0]!);
    expect(stripe.cancelPaymentIntent.mock.invocationCallOrder[0]).toBeLessThan(stripe.createPaymentIntent.mock.invocationCallOrder[0]!);
  });

  it('T4e two concurrent replacers: the reservation CAS lets only one reach Stripe', async () => {
    prisma.dayPass.findUnique
      .mockResolvedValueOnce(slot())
      .mockResolvedValueOnce({ status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_old' });
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ status: 'canceled' }));
    prisma.dayPass.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassAttemptInProgress });
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it('T4c defensive: an intent the slot currently holds is never cancelled by a CAS loser', async () => {
    prisma.dayPass.findUnique
      .mockResolvedValueOnce(slot())
      .mockResolvedValueOnce({ status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_new_2' });
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ status: 'canceled' }));
    prisma.dayPass.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassAttemptInProgress });
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it('T5 price rotated since the attempt: stale intent is canceled (never payable at the old amount) and replaced', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot({ priceCents: 20000 }));
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ amount: 20000 }));

    const res = await purchase();

    expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_old', 'abandoned');
    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ priceCents: PRICE, stripePaymentIntentId: 'pi_new_2' }) }),
    );
    expect(res.paymentIntentClientSecret).toBe('pi_new_2_secret');
  });

  it('T5b stale intent whose cancel fails because it is now processing → 409 processing, never a second intent at the new price', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot({ priceCents: 20000 }));
    stripe.retrievePaymentIntent
      .mockResolvedValueOnce(representablePi({ amount: 20000 }))
      .mockResolvedValueOnce(representablePi({ amount: 20000, status: 'processing' }));
    stripe.cancelPaymentIntent.mockRejectedValue(Object.assign(new Error('unexpected state'), { code: 'payment_intent_unexpected_state' }));

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassPaymentProcessing });
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('T6 intent already succeeded (webhook late or missing): activates from Stripe truth, then reports ownership', async () => {
    prisma.dayPass.findUnique
      .mockResolvedValueOnce(slot()) // slot lookup
      .mockResolvedValueOnce({
        // activation lookup
        id: 'dp_1',
        studioId: STUDIO,
        userId: USER,
        status: DayPassStatus.PENDING,
        priceCents: PRICE,
        currency: 'mxn',
        stripePaymentIntentId: 'pi_old',
        previousStripePaymentIntentIds: [], studio: { timezone: 'America/Mexico_City' },
        validForDate: studioLocalDateKeyToUtcAnchor(todayKey(), TZ),
      });
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ status: 'succeeded' }));

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassAlreadyOwned });

    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dp_1', status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_old' },
        data: expect.objectContaining({ status: DayPassStatus.ACTIVE }),
      }),
    );
    expect(prisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stripePaymentIntentId: 'pi_old' } }),
    );
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('T6b intent succeeded but was REFUNDED at Stripe (webhook lost) → no activation, no Payment, 409 needs support', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot());
    stripe.retrievePaymentIntent.mockResolvedValue(
      representablePi({ status: 'succeeded', latest_charge: { id: 'ch_1', amount_refunded: PRICE, refunded: true } }),
    );

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassNeedsSupport });
    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.upsert).not.toHaveBeenCalled();
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('T7 intent processing: member is told to wait; no second intent is ever minted', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot());
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ status: 'processing' }));

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassPaymentProcessing });
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it('T8 double tap: a slot created moments ago without an intent yet is an attempt in progress (409), not a takeover', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(
      slot({ stripePaymentIntentId: null, lastAttemptAt: new Date(Date.now() - 1000) }),
    );

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassAttemptInProgress });
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('T9 a slot orphaned by a crashed request (no intent, older than the grace window) is taken over', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(
      slot({ stripePaymentIntentId: null, lastAttemptAt: new Date(Date.now() - IN_FLIGHT_GRACE_MS - 5000) }),
    );

    const res = await purchase();

    expect(stripe.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(res.paymentIntentClientSecret).toBe('pi_new_2_secret');
    expect(prisma.dayPass.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'dp_1', status: { not: DayPassStatus.ACTIVE }, stripePaymentIntentId: null, attemptCount: 1 },
      data: { attemptCount: 2, lastAttemptAt: expect.any(Date) },
    });
    expect(prisma.dayPass.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'dp_1', status: { not: DayPassStatus.ACTIVE }, stripePaymentIntentId: null, attemptCount: 2 },
        data: expect.not.objectContaining({ previousStripePaymentIntentIds: expect.anything() }),
      }),
    );
  });

  it('T9b CAS on a fresh slot: if another request bound a different intent first, ours is cancelled and the member retries', async () => {
    prisma.dayPass.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_other' });
    prisma.dayPass.updateMany.mockResolvedValue({ count: 0 });

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassAttemptInProgress });
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_new_1', 'duplicate');
    expect(prisma.dayPass.deleteMany).not.toHaveBeenCalled();
  });

  it('T10 concurrent first purchases: the loser of the unique-slot race gets 409 attempt-in-progress, not a second intent', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(null);
    prisma.dayPass.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
    );

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassAttemptInProgress });
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('T11 a past date in the studio timezone is rejected in Spanish before any Stripe or DB write', async () => {
    await expect(
      service.createDayPassPaymentSheet({ studioId: STUDIO, userId: USER, validForDate: '2020-01-01' }),
    ).rejects.toMatchObject({ constructor: BadRequestException, message: MEMBER_ERRORS.dayPassDateInPast });
    expect(prisma.dayPass.findUnique).not.toHaveBeenCalled();
    expect(stripe.createOrRetrieveCustomer).not.toHaveBeenCalled();
  });

  it('T11b omitted validForDate: the SERVER picks today in the studio timezone (client clock irrelevant)', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(null);
    await service.createDayPassPaymentSheet({ studioId: STUDIO, userId: USER });
    expect(prisma.dayPass.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ validForDate: studioLocalDateKeyToUtcAnchor(todayKey(), TZ) }) }),
    );
    const [params] = stripe.createPaymentIntent.mock.calls[0] as [{ metadata: Record<string, string> }];
    expect(params.metadata.validForDate).toBe(todayKey());
  });

  it('T11c a non-canonical or far-future date is refused in Spanish (no silent normalisation, no arbitrary future pass)', async () => {
    await expect(
      service.createDayPassPaymentSheet({ studioId: STUDIO, userId: USER, validForDate: '2099-13-01' }),
    ).rejects.toMatchObject({ constructor: BadRequestException, message: MEMBER_ERRORS.dayPassDateInvalid });
    await expect(
      service.createDayPassPaymentSheet({ studioId: STUDIO, userId: USER, validForDate: '2099-01-01' }),
    ).rejects.toMatchObject({ constructor: BadRequestException, message: MEMBER_ERRORS.dayPassDateBeyondHorizon });
    expect(prisma.dayPass.findUnique).not.toHaveBeenCalled();
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('T11e the member CHOOSES a future day: it becomes the slot, the intent metadata and the response', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(null);
    const chosen = addDaysToDateKey(todayKey(), 7);

    const res = await service.createDayPassPaymentSheet({ studioId: STUDIO, userId: USER, validForDate: chosen });

    expect(prisma.dayPass.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studioId_userId_validForDate: { studioId: STUDIO, userId: USER, validForDate: studioLocalDateKeyToUtcAnchor(chosen, TZ) } } }),
    );
    const [params, options] = stripe.createPaymentIntent.mock.calls[0] as [{ metadata: Record<string, string> }, { idempotencyKey: string }];
    expect(params.metadata.validForDate).toBe(chosen);
    expect(options.idempotencyKey).toBe(`day_pass:dp_1:a1:${PRICE}:mxn`); // slot id is date-scoped, so the key is too
    expect(res.validForDate).toBe(chosen);
  });

  it('T11d a REFUNDED slot is never re-opened automatically (a late event could re-activate refunded money) → 409 needs support', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot({ status: DayPassStatus.REFUNDED, stripePaymentIntentId: 'pi_refunded' }));

    await expect(purchase()).rejects.toMatchObject({ message: MEMBER_ERRORS.dayPassNeedsSupport });
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
  });

  it('T12 intent creation fails on a fresh slot: the intentless slot is released so the next tap is not stuck', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(null);
    stripe.createPaymentIntent.mockRejectedValue(new Error('stripe down'));

    await expect(purchase()).rejects.toThrow('stripe down');
    expect(prisma.dayPass.deleteMany).toHaveBeenCalledWith({
      where: { id: 'dp_1', status: DayPassStatus.PENDING, stripePaymentIntentId: null },
    });
  });

  it('T13 ephemeral key fails after the intent is persisted: slot is KEPT (retry re-presents), nothing deleted', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(null);
    stripe.createEphemeralKey.mockRejectedValue(new Error('ek down'));

    await expect(purchase()).rejects.toThrow('ek down');
    expect(prisma.dayPass.deleteMany).not.toHaveBeenCalled();
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stripePaymentIntentId: 'pi_new_1' }) }),
    );
  });

  it('T14 an intent Stripe no longer knows (resource_missing) is replaced rather than blocking', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot());
    stripe.retrievePaymentIntent.mockRejectedValue(Object.assign(new Error('nope'), { code: 'resource_missing', statusCode: 404 }));

    const res = await purchase();
    expect(res.paymentIntentClientSecret).toBe('pi_new_2_secret');
  });

  it('T15 Stripe outage while checking the intent propagates (no guess, no grant)', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(slot());
    stripe.retrievePaymentIntent.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'api_connection_error' }));

    await expect(purchase()).rejects.toThrow('timeout');
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
    expect(prisma.dayPass.update).not.toHaveBeenCalled();
    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
  });

  it('T16 listMyDayPasses exposes purchased passes only — never open attempts; legacy default keeps newest-first order', async () => {
    prisma.dayPass.findMany.mockResolvedValue([]);
    await service.listMyDayPasses(STUDIO, USER);
    expect(prisma.dayPass.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studioId: STUDIO, userId: USER, status: DayPassStatus.ACTIVE }, orderBy: { validForDate: 'desc' } }),
    );
  });

  it('T16b listMyDayPasses(upcoming) returns today+future soonest first, each row carrying its studio-local day and today/upcoming', async () => {
    const t = todayKey();
    const rows = [t, addDaysToDateKey(t, 3), addDaysToDateKey(t, 6)].map((k, i) => ({
      id: `dp_${i}`, validForDate: studioLocalDateKeyToUtcAnchor(k, TZ), status: DayPassStatus.ACTIVE, priceCents: PRICE, currency: 'mxn', createdAt: new Date(),
    }));
    prisma.dayPass.findMany.mockResolvedValue(rows);

    const out = await service.listMyDayPasses(STUDIO, USER, 'upcoming');

    expect(prisma.dayPass.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: DayPassStatus.ACTIVE, validForDate: { gte: studioLocalDateKeyToUtcAnchor(t, TZ) } }),
        orderBy: { validForDate: 'asc' },
      }),
    );
    expect(out.map((p) => [p.validForDateKey, p.relativeDay])).toEqual([[t, 'today'], [addDaysToDateKey(t, 3), 'upcoming'], [addDaysToDateKey(t, 6), 'upcoming']]);
  });

  it('T16c listMyDayPasses(history) returns only past days, most recent first, classified as past', async () => {
    const t = todayKey();
    prisma.dayPass.findMany.mockResolvedValue([{ id: 'dp_old', validForDate: studioLocalDateKeyToUtcAnchor(addDaysToDateKey(t, -2), TZ), status: DayPassStatus.ACTIVE, priceCents: PRICE, currency: 'mxn', createdAt: new Date() }]);
    const out = await service.listMyDayPasses(STUDIO, USER, 'history');
    expect(prisma.dayPass.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ validForDate: { lt: studioLocalDateKeyToUtcAnchor(t, TZ) } }), orderBy: { validForDate: 'desc' } }),
    );
    expect(out[0]?.relativeDay).toBe('past');
  });

  it('T16d getPurchaseWindow returns studio-local today, the horizon and the owned days inside it', async () => {
    const t = todayKey();
    prisma.dayPass.findMany.mockResolvedValue([{ validForDate: studioLocalDateKeyToUtcAnchor(addDaysToDateKey(t, 1), TZ) }]);
    const w = await service.getPurchaseWindow(STUDIO, USER);
    expect(w).toEqual({ timezone: TZ, todayKey: t, maxDateKey: addDaysToDateKey(t, 30), horizonDays: 30, ownedDateKeys: [addDaysToDateKey(t, 1)] });
    expect(prisma.dayPass.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: DayPassStatus.ACTIVE, validForDate: { gte: studioLocalDateKeyToUtcAnchor(t, TZ), lte: studioLocalDateKeyToUtcAnchor(addDaysToDateKey(t, 30), TZ) } }) }),
    );
  });
});

describe('DayPassesService — post-payment sync (server-verified, client never trusted)', () => {
  const prisma = {
    dayPass: { findFirst: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment: { upsert: jest.fn(), findUnique: jest.fn() },
  };
  const stripe = { retrievePaymentIntent: jest.fn(), cancelPaymentIntent: jest.fn() };
  const service = new DayPassesService(prisma as never, stripe as never, {} as never, {} as never, {} as never);
  const row = {
    id: 'dp_1',
    validForDate: new Date('2026-09-23T06:00:00.000Z'),
    status: DayPassStatus.PENDING,
    priceCents: PRICE,
    currency: 'mxn',
    createdAt: new Date(),
    stripePaymentIntentId: 'pi_1',
    studio: { timezone: TZ },
  };

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.payment.findUnique.mockResolvedValue(null);
    prisma.dayPass.findFirst.mockResolvedValue(row);
    prisma.dayPass.update.mockResolvedValue({});
    prisma.dayPass.updateMany.mockResolvedValue({ count: 1 });
    prisma.payment.upsert.mockResolvedValue({});
  });

  it('T17 activates when Stripe says succeeded, through the shared activation routine', async () => {
    stripe.retrievePaymentIntent.mockResolvedValue(representablePi({ id: 'pi_1', status: 'succeeded' }));
    prisma.dayPass.findUnique.mockResolvedValue({
      ...row,
      studioId: STUDIO,
      userId: USER,
      previousStripePaymentIntentIds: [], studio: { timezone: 'America/Mexico_City' },
    });
    prisma.dayPass.findUniqueOrThrow.mockResolvedValue({ ...row, status: DayPassStatus.ACTIVE });

    const dto = await service.syncDayPassFromStripe({ studioId: STUDIO, userId: USER, dayPassId: 'dp_1' });

    expect(dto.status).toBe(DayPassStatus.ACTIVE);
    expect(dto.validForDateKey).toBe('2026-09-23'); // the purchased day, on the studio clock
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dp_1', status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_1' },
        data: expect.objectContaining({ status: DayPassStatus.ACTIVE }),
      }),
    );
    expect(prisma.payment.upsert).toHaveBeenCalledTimes(1);
  });

  it('T18 does NOT activate when Stripe says otherwise; only caches the decline telemetry', async () => {
    stripe.retrievePaymentIntent.mockResolvedValue(
      representablePi({ id: 'pi_1', last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' } }),
    );
    prisma.dayPass.findUniqueOrThrow.mockResolvedValue(row);

    const dto = await service.syncDayPassFromStripe({ studioId: STUDIO, userId: USER, dayPassId: 'dp_1' });

    expect(dto.status).toBe(DayPassStatus.PENDING);
    expect(prisma.dayPass.update).not.toHaveBeenCalled();
    expect(prisma.dayPass.updateMany).toHaveBeenCalledTimes(1); // telemetry only, never a promotion
    expect(prisma.payment.upsert).not.toHaveBeenCalled();
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dp_1', status: { not: DayPassStatus.ACTIVE }, stripePaymentIntentId: 'pi_1' },
        data: {
          lastStripeStatus: 'requires_payment_method',
          lastPaymentErrorCode: 'card_declined',
          lastPaymentDeclineCode: 'insufficient_funds',
        },
      }),
    );
  });

  it('T19 is a no-op for another member’s pass (tenant scoping) ', async () => {
    prisma.dayPass.findFirst.mockResolvedValue(null);
    await expect(
      service.syncDayPassFromStripe({ studioId: STUDIO, userId: 'someone-else', dayPassId: 'dp_1' }),
    ).rejects.toThrow('Day Pass not found');
    expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
  });
});
