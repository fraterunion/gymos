import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DayPassSettingsService } from './day-pass-settings.service';

const baseSettings = {
  id: 'settings-1',
  studioId: 'studio-1',
  displayName: 'Day Pass',
  priceCents: 20000,
  currency: 'mxn',
  active: true,
  stripeProductId: 'prod_day_pass',
  stripePriceId: 'price_old_200',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('DayPassSettingsService', () => {
  const prisma = {
    studio: { findFirst: jest.fn() },
    studioDayPassSettings: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const config = {
    get: jest.fn((key: string, fallback?: string) => {
      if (key === 'DAY_PASS_PRICE_CENTS') return '20000';
      if (key === 'DAY_PASS_CURRENCY') return 'mxn';
      return fallback;
    }),
  };
  const stripe = {
    retrievePrice: jest.fn(),
    createOneTimePrice: jest.fn(),
    createProductForPlan: jest.fn(),
    deactivatePrice: jest.fn().mockResolvedValue({}),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new DayPassSettingsService(
    prisma as never,
    stripe as never,
    config as never,
    audit as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.studio.findFirst.mockResolvedValue({ id: 'studio-1' });
    prisma.studioDayPassSettings.findUnique.mockResolvedValue(baseSettings);
    prisma.studioDayPassSettings.findUniqueOrThrow.mockImplementation(async (args: { where: { id: string } }) => ({
      ...baseSettings,
      id: args.where.id,
    }));
    prisma.studioDayPassSettings.updateMany.mockResolvedValue({ count: 1 });
  });

  it('GET with no settings row returns effective config without DB writes', async () => {
    prisma.studioDayPassSettings.findUnique.mockResolvedValue(null);

    const result = await service.getSettings('studio-1');

    expect(result.configured).toBe(false);
    expect(result.id).toBeNull();
    expect(result.priceCents).toBe(20000);
    expect(result.currency).toBe('mxn');
    expect(result.integrity.status).toBe('missing_price');
    expect(prisma.studioDayPassSettings.create).not.toHaveBeenCalled();
  });

  it('getCatalog is read-only when no settings row exists', async () => {
    prisma.studioDayPassSettings.findUnique.mockResolvedValue(null);

    const catalog = await service.getCatalog('studio-1');

    expect(catalog).toEqual({
      displayName: 'Day Pass',
      priceCents: 20000,
      currency: 'mxn',
      active: true,
      validityDescription: expect.any(String),
    });
    expect(prisma.studioDayPassSettings.create).not.toHaveBeenCalled();
  });

  it('PATCH first save persists settings intentionally', async () => {
    prisma.studioDayPassSettings.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue(baseSettings);
    prisma.studioDayPassSettings.create.mockResolvedValue({
      ...baseSettings,
      stripeProductId: null,
      stripePriceId: null,
    });
    stripe.createProductForPlan.mockResolvedValue({ id: 'prod_new' });
    stripe.createOneTimePrice.mockResolvedValue({ id: 'price_new_200' });
    stripe.retrievePrice.mockResolvedValue({
      id: 'price_new_200',
      unit_amount: 20000,
      currency: 'mxn',
      active: true,
      recurring: null,
    });
    prisma.studioDayPassSettings.update.mockResolvedValue({
      ...baseSettings,
      displayName: 'Pase diario',
      stripeProductId: 'prod_new',
      stripePriceId: 'price_new_200',
    });

    await service.updateSettings('studio-1', { displayName: 'Pase diario' }, 'admin-1');

    expect(prisma.studioDayPassSettings.create).toHaveBeenCalledTimes(1);
    expect(stripe.createOneTimePrice).toHaveBeenCalled();
  });

  it('rotates Stripe Price when price changes and reuses Product', async () => {
    stripe.createOneTimePrice.mockResolvedValue({ id: 'price_new_350' });
    prisma.studioDayPassSettings.update.mockResolvedValue({
      ...baseSettings,
      priceCents: 35000,
      stripePriceId: 'price_new_350',
    });
    stripe.retrievePrice.mockResolvedValue({
      id: 'price_new_350',
      unit_amount: 35000,
      currency: 'mxn',
      active: true,
      recurring: null,
    });

    await service.updateSettings('studio-1', { priceCents: 35000 }, 'admin-1');

    expect(stripe.createProductForPlan).not.toHaveBeenCalled();
    expect(stripe.createOneTimePrice).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'prod_day_pass',
        unitAmount: 35000,
      }),
      expect.objectContaining({
        idempotencyKey: 'day-pass-price:settings-1:35000:mxn',
      }),
    );
    expect(stripe.deactivatePrice).toHaveBeenCalledWith('price_old_200');
  });

  it('200→300→250 reuses the same Stripe Product across rotations', async () => {
    const settingsAt200 = { ...baseSettings, priceCents: 20000, stripePriceId: 'price_200' };
    const settingsAt300 = { ...settingsAt200, priceCents: 30000, stripePriceId: 'price_300' };

    prisma.studioDayPassSettings.findUnique.mockResolvedValue(settingsAt200);
    stripe.createOneTimePrice
      .mockResolvedValueOnce({ id: 'price_300' })
      .mockResolvedValueOnce({ id: 'price_250' });
    prisma.studioDayPassSettings.update
      .mockResolvedValueOnce(settingsAt300)
      .mockResolvedValueOnce({ ...settingsAt300, priceCents: 25000, stripePriceId: 'price_250' });
    stripe.retrievePrice.mockResolvedValue({
      id: 'price_250',
      unit_amount: 25000,
      currency: 'mxn',
      active: true,
      recurring: null,
    });

    await service.updateSettings('studio-1', { priceCents: 30000 }, 'admin-1');
    prisma.studioDayPassSettings.findUnique.mockResolvedValue(settingsAt300);
    await service.updateSettings('studio-1', { priceCents: 25000 }, 'admin-1');

    expect(stripe.createProductForPlan).not.toHaveBeenCalled();
    expect(stripe.createOneTimePrice).toHaveBeenCalledTimes(2);
    expect(stripe.deactivatePrice).toHaveBeenCalledWith('price_200');
    expect(stripe.deactivatePrice).toHaveBeenCalledWith('price_300');
  });

  it('leaves GymOS unchanged when Stripe Price create fails', async () => {
    stripe.createOneTimePrice.mockRejectedValue(new Error('stripe down'));

    await expect(
      service.updateSettings('studio-1', { priceCents: 35000 }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.studioDayPassSettings.update).not.toHaveBeenCalled();
  });

  it('reconcile bootstraps when no row exists', async () => {
    prisma.studioDayPassSettings.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ...baseSettings, stripePriceId: null, stripeProductId: null });
    prisma.studioDayPassSettings.create.mockResolvedValue({
      ...baseSettings,
      stripeProductId: null,
      stripePriceId: null,
    });
    stripe.createProductForPlan.mockResolvedValue({ id: 'prod_new' });
    stripe.createOneTimePrice.mockResolvedValue({ id: 'price_new_200' });
    stripe.retrievePrice.mockResolvedValue({
      id: 'price_stale',
      unit_amount: 25000,
      currency: 'mxn',
      active: true,
      recurring: null,
    });
    prisma.studioDayPassSettings.findUniqueOrThrow.mockResolvedValue({
      ...baseSettings,
      stripeProductId: 'prod_new',
      stripePriceId: 'price_new_200',
    });

    const result = await service.reconcileStripeSalePrice('studio-1', 'admin-1');

    expect(prisma.studioDayPassSettings.create).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('reconciled');
  });

  it('resolveCheckoutSalePrice bootstraps unpersisted settings and uses env defaults', async () => {
    prisma.studioDayPassSettings.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        ...baseSettings,
        stripeProductId: 'prod_checkout',
        stripePriceId: 'price_checkout_200',
      });
    prisma.studioDayPassSettings.create.mockResolvedValue({
      ...baseSettings,
      stripeProductId: null,
      stripePriceId: null,
    });
    stripe.createProductForPlan.mockResolvedValue({ id: 'prod_checkout' });
    stripe.createOneTimePrice.mockResolvedValue({ id: 'price_checkout_200' });
    stripe.retrievePrice.mockResolvedValue({
      id: 'price_checkout_200',
      unit_amount: 20000,
      currency: 'mxn',
      active: true,
      recurring: null,
    });
    prisma.studioDayPassSettings.findUniqueOrThrow.mockResolvedValue({
      ...baseSettings,
      stripeProductId: 'prod_checkout',
      stripePriceId: 'price_checkout_200',
    });

    const sale = await service.resolveCheckoutSalePrice('studio-1', 'member-1');

    expect(prisma.studioDayPassSettings.create).toHaveBeenCalledTimes(1);
    expect(sale.priceCents).toBe(20000);
    expect(sale.stripePriceId).toBe('price_checkout_200');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DAY_PASS_CHECKOUT_BOOTSTRAP' }),
    );
  });

  it('resolveCheckoutSalePrice refuses inactive Day Pass', async () => {
    prisma.studioDayPassSettings.findUnique.mockResolvedValue({
      ...baseSettings,
      active: false,
    });

    await expect(service.resolveCheckoutSalePrice('studio-1', 'member-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('concurrent checkout bootstrap creates only one settings row', async () => {
    const bootstrapped = {
      ...baseSettings,
      stripeProductId: 'prod_winner',
      stripePriceId: 'price_winner',
    };
    prisma.studioDayPassSettings.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(bootstrapped);
    prisma.studioDayPassSettings.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    stripe.retrievePrice.mockResolvedValue({
      id: 'price_winner',
      unit_amount: 20000,
      currency: 'mxn',
      active: true,
      recurring: null,
    });

    const sale = await service.resolveCheckoutSalePrice('studio-1', 'member-1');

    expect(prisma.studioDayPassSettings.create).toHaveBeenCalledTimes(1);
    expect(sale.stripePriceId).toBe('price_winner');
    expect(stripe.createOneTimePrice).not.toHaveBeenCalled();
  });
});
