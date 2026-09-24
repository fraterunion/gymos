import { DayPassStatus, PaymentStatus } from '@prisma/client';
import { StripeWebhookService } from './stripe-webhook.service';

/**
 * Day Pass webhook semantics: succeeded activates (idempotently, via the shared routine),
 * payment_failed / canceled only cache telemetry for the slot's CURRENT intent, and nothing
 * can downgrade an ACTIVE pass or grant on an intent the slot never issued.
 */

const STUDIO = 'studio-1';
const USER = 'user-1';

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dp_1',
    studioId: STUDIO,
    userId: USER,
    status: DayPassStatus.PENDING,
    priceCents: 25000,
    currency: 'mxn',
    stripePaymentIntentId: 'pi_1',
    previousStripePaymentIntentIds: [], studio: { timezone: 'America/Mexico_City' },
    validForDate: new Date('2026-09-23T06:00:00.000Z'),
    ...overrides,
  };
}

function event(type: string, object: Record<string, unknown>, id = 'evt_1') {
  return { id, type, data: { object } };
}

const piBase = {
  id: 'pi_1',
  status: 'succeeded',
  created: 1_758_600_000,
  amount: 25000,
  currency: 'mxn',
  customer: 'cus_1',
  metadata: { type: 'day_pass', dayPassId: 'dp_1', studioId: STUDIO, userId: USER },
};

describe('StripeWebhookService — Day Pass PaymentIntent events', () => {
  const prisma = {
    dayPass: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment: { upsert: jest.fn(), findUnique: jest.fn() },
  };
  const stripeSvc = { cancelPaymentIntent: jest.fn().mockResolvedValue({}) };
  const service = new StripeWebhookService(
    prisma as never,
    stripeSvc as never,
    {} as never,
    {} as never,
    { activateScheduledCashIfDue: jest.fn().mockResolvedValue(null) } as never,
    { maybeLogExternalRenewalChange: jest.fn() } as never,
  );
  const dispatch = (e: ReturnType<typeof event>) =>
    (service as unknown as { dispatch: (e: unknown) => Promise<void> }).dispatch(e);

  beforeEach(() => {
    jest.resetAllMocks();
    stripeSvc.cancelPaymentIntent.mockResolvedValue({});
    prisma.payment.findUnique.mockResolvedValue(null);
    prisma.dayPass.update.mockResolvedValue({});
    prisma.dayPass.updateMany.mockResolvedValue({ count: 1 });
    prisma.payment.upsert.mockResolvedValue({});
  });

  it('W1 payment_intent.succeeded activates a PENDING slot and records the Payment from the intent amount', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow());

    await dispatch(event('payment_intent.succeeded', piBase));

    // Compare-and-swap: only the exact row state that was read may be promoted.
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dp_1', status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_1' },
        data: expect.objectContaining({ status: DayPassStatus.ACTIVE, stripePaymentIntentId: 'pi_1', lastStripeStatus: 'succeeded' }),
      }),
    );
    expect(prisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripePaymentIntentId: 'pi_1' },
        create: expect.objectContaining({ amountCents: 25000, currency: 'mxn', status: PaymentStatus.SUCCEEDED, userId: USER, studioId: STUDIO }),
      }),
    );
  });

  it('W1b CAS race: a retry replaced the intent between read and write → re-read, rebind the PAID intent, cancel the unpaid replacement', async () => {
    prisma.dayPass.findUnique
      .mockResolvedValueOnce(pendingRow()) // read 1: current intent is the paid one (pi_1)
      .mockResolvedValueOnce(pendingRow({ stripePaymentIntentId: 'pi_2', previousStripePaymentIntentIds: ['pi_1'] })); // read 2: replaced
    prisma.dayPass.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    await dispatch(event('payment_intent.succeeded', piBase));

    expect(prisma.dayPass.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.dayPass.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'dp_1', status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_2' },
        data: expect.objectContaining({ status: DayPassStatus.ACTIVE, stripePaymentIntentId: 'pi_1', previousStripePaymentIntentIds: ['pi_2'] }),
      }),
    );
    expect(stripeSvc.cancelPaymentIntent).toHaveBeenCalledWith('pi_2', 'duplicate');
    // The idempotent Payment upsert runs once per attempt, always keyed by the paid intent.
    expect(prisma.payment.upsert).toHaveBeenCalledTimes(2);
    for (const call of prisma.payment.upsert.mock.calls as Array<[{ where: unknown }]>) {
      expect(call[0].where).toEqual({ stripePaymentIntentId: 'pi_1' });
    }
  });

  it('W1c persistent contention throws (event stays unprocessed so Stripe redelivers); the money is still recorded once', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow());
    prisma.dayPass.updateMany.mockResolvedValue({ count: 0 });

    await expect(dispatch(event('payment_intent.succeeded', piBase))).rejects.toThrow(/consecutive races/);
    expect(prisma.dayPass.updateMany).toHaveBeenCalledTimes(3);
    // Idempotent upsert keyed by the intent: one Payment row however many times it runs.
    for (const call of prisma.payment.upsert.mock.calls as Array<[{ where: unknown }]>) {
      expect(call[0].where).toEqual({ stripePaymentIntentId: 'pi_1' });
    }
  });

  it('W1d the Payment row is written BEFORE the slot is promoted (a crash in between completes on redelivery)', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow());
    prisma.dayPass.updateMany.mockResolvedValue({ count: 1 });

    await dispatch(event('payment_intent.succeeded', piBase));

    expect(prisma.payment.upsert.mock.invocationCallOrder[0]).toBeLessThan(prisma.dayPass.updateMany.mock.invocationCallOrder[0]!);
  });

  it('W14 a succeeded redelivery for a payment already marked REFUNDED grants nothing and never flips the refund back', async () => {
    prisma.payment.findUnique.mockResolvedValue({ status: PaymentStatus.REFUNDED });
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow());

    await dispatch(event('payment_intent.succeeded', piBase));

    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.upsert).not.toHaveBeenCalled();
  });

  it('W2 replayed succeeded event is idempotent: no second activation, Payment upsert repairs but never duplicates', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow({ status: DayPassStatus.ACTIVE }));

    await dispatch(event('payment_intent.succeeded', piBase, 'evt_replay'));

    expect(prisma.dayPass.update).not.toHaveBeenCalled();
    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.payment.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { stripePaymentIntentId: 'pi_1' } }));
  });

  it('W3 succeeded on an intent the slot never issued grants nothing', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow({ stripePaymentIntentId: 'pi_other' }));

    await dispatch(event('payment_intent.succeeded', piBase));

    expect(prisma.dayPass.update).not.toHaveBeenCalled();
    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.upsert).not.toHaveBeenCalled();
  });

  it('W4 succeeded on a REPLACED intent (in slot history) is honoured as money moved: it becomes the intent of record and the unpaid replacement is cancelled', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(
      pendingRow({ stripePaymentIntentId: 'pi_2', previousStripePaymentIntentIds: ['pi_1'] }),
    );

    await dispatch(event('payment_intent.succeeded', piBase));

    const call = (prisma.dayPass.updateMany.mock.calls[0] as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0];
    expect(call.where).toEqual({ id: 'dp_1', status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_2' });
    // The paid intent leaves the trail; the unpaid replacement joins it.
    expect(call.data).toMatchObject({
      status: DayPassStatus.ACTIVE,
      stripePaymentIntentId: 'pi_1',
      previousStripePaymentIntentIds: ['pi_2'],
    });
    expect(prisma.payment.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { stripePaymentIntentId: 'pi_1' } }));
    expect(stripeSvc.cancelPaymentIntent).toHaveBeenCalledWith('pi_2', 'duplicate');
  });

  it('W4b a second SUCCESS on an already ACTIVE slot (double charge) is recorded as a Payment and flagged, never dropped', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(
      pendingRow({ status: DayPassStatus.ACTIVE, stripePaymentIntentId: 'pi_2', previousStripePaymentIntentIds: ['pi_1'] }),
    );

    await dispatch(event('payment_intent.succeeded', piBase));

    expect(prisma.dayPass.update).not.toHaveBeenCalled();
    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { stripePaymentIntentId: 'pi_1' } }));
    expect(stripeSvc.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it('W5 a REFUNDED slot is terminal: late succeeded is ignored', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow({ status: DayPassStatus.REFUNDED }));
    await dispatch(event('payment_intent.succeeded', piBase));
    expect(prisma.dayPass.update).not.toHaveBeenCalled();
    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.upsert).not.toHaveBeenCalled();
  });

  it('W6 an EXPIRED attempt that Stripe reports paid is activated (payment is the authority) — flagged, not dropped', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow({ status: DayPassStatus.EXPIRED }));
    await dispatch(event('payment_intent.succeeded', piBase));
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dp_1', status: DayPassStatus.EXPIRED, stripePaymentIntentId: 'pi_1' },
        data: expect.objectContaining({ status: DayPassStatus.ACTIVE, expiredAt: null }),
      }),
    );
  });

  it('W7 tenant mismatch in metadata never activates', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow({ studioId: 'studio-2' }));
    await dispatch(event('payment_intent.succeeded', piBase));
    expect(prisma.dayPass.update).not.toHaveBeenCalled();
    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.upsert).not.toHaveBeenCalled();
  });

  it('W8 non-day-pass intents are ignored by all three handlers', async () => {
    for (const type of ['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled']) {
      await dispatch(event(type, { ...piBase, metadata: { type: 'something_else' } }));
    }
    expect(prisma.dayPass.findUnique).not.toHaveBeenCalled();
  });

  it('W9 payment_failed caches the decline on the current intent and leaves the slot PENDING (retry stays possible)', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow());

    await dispatch(
      event('payment_intent.payment_failed', {
        ...piBase,
        status: 'requires_payment_method',
        last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' },
      }),
    );

    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith({
      where: { id: 'dp_1', stripePaymentIntentId: 'pi_1', status: { not: DayPassStatus.ACTIVE } },
      data: {
        lastStripeStatus: 'requires_payment_method',
        lastPaymentErrorCode: 'card_declined',
        lastPaymentDeclineCode: 'insufficient_funds',
      },
    });
    const data = (prisma.dayPass.updateMany.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data).not.toHaveProperty('status');
    expect(prisma.dayPass.update).not.toHaveBeenCalled();
  });

  it('W10 payment_intent.canceled caches the cancellation and keeps the slot reusable', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow());

    await dispatch(event('payment_intent.canceled', { ...piBase, status: 'canceled', cancellation_reason: 'abandoned' }));

    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastStripeStatus: 'canceled' } }),
    );
  });

  it('W11 a failure for a REPLACED (stale) intent does not touch the slot’s current attempt', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow({ stripePaymentIntentId: 'pi_2', previousStripePaymentIntentIds: ['pi_1'] }));

    await dispatch(event('payment_intent.payment_failed', { ...piBase, status: 'requires_payment_method' }));

    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
  });

  it('W12 out-of-order delivery: a failure arriving after success never downgrades an ACTIVE pass', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow({ status: DayPassStatus.ACTIVE }));

    await dispatch(event('payment_intent.payment_failed', { ...piBase, status: 'requires_payment_method' }));
    await dispatch(event('payment_intent.canceled', { ...piBase, status: 'canceled' }));

    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
    expect(prisma.dayPass.update).not.toHaveBeenCalled();
  });

  it('W13 succeeded with a different amount than the slot snapshot still activates and records the REAL charged amount', async () => {
    prisma.dayPass.findUnique.mockResolvedValue(pendingRow({ priceCents: 20000 }));

    await dispatch(event('payment_intent.succeeded', { ...piBase, amount: 25000 }));

    expect(prisma.payment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ amountCents: 25000 }) }),
    );
  });
});
