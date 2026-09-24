import { DayPassStatus } from '@prisma/client';
import { studioLocalDateKeyToUtcAnchor } from '../common/date/studio-local-date';
import { DayPassAttemptSweepService } from './day-pass-attempt-sweep.service';

describe('DayPassAttemptSweepService', () => {
  const prisma = {
    dayPass: { groupBy: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    studio: { findMany: jest.fn() },
    payment: { upsert: jest.fn(), findUnique: jest.fn() },
  };
  const stripe = { retrievePaymentIntent: jest.fn(), cancelPaymentIntent: jest.fn() };
  const config = { get: jest.fn((_k: string, d?: string) => d) };
  const service = new DayPassAttemptSweepService(prisma as never, stripe as never, config as never, undefined);

  const candidate = (id: string, pi: string | null, validForDate = new Date('2026-09-20T06:00:00.000Z')) => ({
    id,
    userId: 'u1',
    validForDate,
    stripePaymentIntentId: pi,
  });
  const piRow = (id: string, status: string) => ({
    id,
    status,
    amount: 25000,
    currency: 'mxn',
    created: 1_758_000_000,
    metadata: { type: 'day_pass', dayPassId: 'dp_paid', studioId: 'mx', userId: 'u1' },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockImplementation((_k: string, d?: string) => d);
    prisma.dayPass.updateMany.mockResolvedValue({ count: 1 });
    prisma.dayPass.update.mockResolvedValue({});
    prisma.payment.upsert.mockResolvedValue({});
    prisma.payment.findUnique.mockResolvedValue(null);
    prisma.dayPass.groupBy.mockResolvedValue([{ studioId: 'mx' }]);
    prisma.studio.findMany.mockResolvedValue([{ id: 'mx', timezone: 'America/Mexico_City' }]);
  });

  it('S1 selects only PENDING attempts strictly before the studio-local today (timezone-aware)', async () => {
    prisma.dayPass.groupBy.mockResolvedValue([{ studioId: 'mx' }, { studioId: 'ny' }]);
    prisma.studio.findMany.mockResolvedValue([
      { id: 'mx', timezone: 'America/Mexico_City' },
      { id: 'ny', timezone: 'America/New_York' },
    ]);
    prisma.dayPass.findMany.mockResolvedValue([]);

    // 05:30Z on Sept 23 is still Sept 22 in Mexico City (UTC-6) but already Sept 23 in New York (EDT).
    await service.expireLapsedAttempts(new Date('2026-09-23T05:30:00.000Z'));

    expect(prisma.dayPass.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studioId: 'mx', status: DayPassStatus.PENDING, validForDate: { lt: studioLocalDateKeyToUtcAnchor('2026-09-22', 'America/Mexico_City') } },
      }),
    );
    expect(prisma.dayPass.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studioId: 'ny', status: DayPassStatus.PENDING, validForDate: { lt: studioLocalDateKeyToUtcAnchor('2026-09-23', 'America/New_York') } },
      }),
    );
  });

  it('S2 expires an abandoned attempt (requires_payment_method) with a CAS on status+intent, without touching Stripe by default', async () => {
    prisma.dayPass.findMany.mockResolvedValue([candidate('dp_1', 'pi_1')]);
    stripe.retrievePaymentIntent.mockResolvedValue(piRow('pi_1', 'requires_payment_method'));
    const now = new Date('2026-09-23T12:00:00.000Z');

    const r = await service.expireLapsedAttempts(now);

    expect(r).toEqual({ expired: 1, activated: 0, deferred: 0 });
    expect(stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith({
      where: { id: 'dp_1', status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_1' },
      data: { status: DayPassStatus.EXPIRED, expiredAt: now, lastStripeStatus: 'requires_payment_method' },
    });
  });

  it('S3 NEVER expires a paid attempt: a succeeded intent (webhook never arrived) is activated instead', async () => {
    prisma.dayPass.findMany.mockResolvedValue([candidate('dp_paid', 'pi_paid')]);
    stripe.retrievePaymentIntent.mockResolvedValue(piRow('pi_paid', 'succeeded'));
    prisma.dayPass.findUnique.mockResolvedValue({
      id: 'dp_paid', studioId: 'mx', userId: 'u1', status: DayPassStatus.PENDING, priceCents: 25000, currency: 'mxn',
      stripePaymentIntentId: 'pi_paid', previousStripePaymentIntentIds: [], studio: { timezone: 'America/Mexico_City' }, validForDate: new Date('2026-09-20T06:00:00.000Z'),
    });

    const r = await service.expireLapsedAttempts(new Date('2026-09-23T12:00:00.000Z'));

    expect(r).toEqual({ expired: 0, activated: 1, deferred: 0 });
    // The only write is the activation CAS (PENDING → ACTIVE); nothing is expired.
    expect(prisma.dayPass.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dp_paid', status: DayPassStatus.PENDING, stripePaymentIntentId: 'pi_paid' },
        data: expect.objectContaining({ status: DayPassStatus.ACTIVE }),
      }),
    );
    expect(prisma.payment.upsert).toHaveBeenCalledTimes(1);
  });

  it('S3b a lapsed attempt paid then REFUNDED at Stripe is neither expired nor activated; it is deferred for an operator', async () => {
    prisma.dayPass.findMany.mockResolvedValue([candidate('dp_paid', 'pi_paid')]);
    stripe.retrievePaymentIntent.mockResolvedValue({ ...piRow('pi_paid', 'succeeded'), latest_charge: { id: 'ch_1', amount_refunded: 25000 } });

    const r = await service.expireLapsedAttempts(new Date('2026-09-23T12:00:00.000Z'));

    expect(r).toEqual({ expired: 0, activated: 0, deferred: 1 });
    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.upsert).not.toHaveBeenCalled();
  });

  it('S4 defers when the intent is processing or Stripe is unreachable (retried next run)', async () => {
    prisma.dayPass.findMany.mockResolvedValue([candidate('dp_a', 'pi_a'), candidate('dp_b', 'pi_b')]);
    stripe.retrievePaymentIntent
      .mockResolvedValueOnce(piRow('pi_a', 'processing'))
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'api_connection_error' }));

    const r = await service.expireLapsedAttempts(new Date('2026-09-23T12:00:00.000Z'));

    expect(r).toEqual({ expired: 0, activated: 0, deferred: 2 });
    expect(prisma.dayPass.updateMany).not.toHaveBeenCalled();
  });

  it('S5 cancels lapsed intents at Stripe only when explicitly enabled by env', async () => {
    config.get.mockImplementation((k: string, d?: string) => (k === 'DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS' ? '1' : d));
    prisma.dayPass.findMany.mockResolvedValue([candidate('dp_1', 'pi_1'), candidate('dp_2', 'pi_2')]);
    stripe.retrievePaymentIntent
      .mockResolvedValueOnce(piRow('pi_1', 'requires_payment_method'))
      .mockResolvedValueOnce(piRow('pi_2', 'canceled'));
    stripe.cancelPaymentIntent.mockResolvedValue({});

    const r = await service.expireLapsedAttempts(new Date('2026-09-23T12:00:00.000Z'));

    expect(r.expired).toBe(2);
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledTimes(1);
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_1', 'abandoned');
  });

  it('S6 an attempt with no intent, or whose intent Stripe no longer knows, is expired as bookkeeping', async () => {
    prisma.dayPass.findMany.mockResolvedValue([candidate('dp_none', null), candidate('dp_gone', 'pi_gone')]);
    stripe.retrievePaymentIntent.mockRejectedValue(Object.assign(new Error('nope'), { code: 'resource_missing' }));

    const r = await service.expireLapsedAttempts(new Date('2026-09-23T12:00:00.000Z'));

    expect(r.expired).toBe(2);
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dp_none', status: DayPassStatus.PENDING, stripePaymentIntentId: null } }),
    );
    expect(prisma.dayPass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastStripeStatus: 'missing' }) }),
    );
  });

  it('S0 the cron is NOT registered unless DAY_PASS_SWEEP_ENABLED=1 (deploy mutates nothing by default)', () => {
    const registry = { addCronJob: jest.fn() };
    const prevE2e = process.env['GYMOS_E2E'];
    delete process.env['GYMOS_E2E'];
    try {
      const off = new DayPassAttemptSweepService(prisma as never, stripe as never, config as never, registry as never);
      off.onModuleInit();
      expect(registry.addCronJob).not.toHaveBeenCalled();

      const onConfig = { get: jest.fn((k: string, d?: string) => (k === 'DAY_PASS_SWEEP_ENABLED' ? '1' : d)) };
      const on = new DayPassAttemptSweepService(prisma as never, stripe as never, onConfig as never, registry as never);
      on.onModuleInit();
      expect(registry.addCronJob).toHaveBeenCalledTimes(1);
      const [name, job] = registry.addCronJob.mock.calls[0] as [string, { stop: () => void }];
      expect(name).toBe('day-pass-attempt-sweep-hourly');
      job.stop();
    } finally {
      if (prevE2e !== undefined) process.env['GYMOS_E2E'] = prevE2e;
    }
  });

  it('S7 is a no-op with no open attempts', async () => {
    prisma.dayPass.groupBy.mockResolvedValue([]);
    expect(await service.expireLapsedAttempts()).toEqual({ expired: 0, activated: 0, deferred: 0 });
    expect(prisma.studio.findMany).not.toHaveBeenCalled();
  });
});
