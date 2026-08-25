import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';

async function loginAccessToken(
  app: INestApplication,
  email: string,
  password: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

describe('Day Pass commercial settings (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: StripeService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stripe = app.get(StripeService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET settings with no row returns effective config and writes nothing', async () => {
    const studio = await createStudio(prisma);
    const owner = await createUserWithPassword(prisma, {
      email: 'owner-get@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/day-pass/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        configured: false,
        id: null,
        priceCents: 20000,
        currency: 'mxn',
        active: true,
        stripeProductId: null,
        stripePriceId: null,
        integrity: expect.objectContaining({ status: 'missing_price' }),
      }),
    );

    const rows = await prisma.studioDayPassSettings.count({ where: { studioId: studio.id } });
    expect(rows).toBe(0);
  });

  it('public discovery catalog exposes only member-safe fields', async () => {
    const studio = await createStudio(prisma, { slug: 'day-pass-public-e2e' });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/public/studios/${studio.slug}/day-pass`)
      .expect(200);

    expect(res.body).toEqual({
      displayName: 'Day Pass',
      priceCents: 20000,
      currency: 'mxn',
      active: true,
      validityDescription: expect.any(String),
    });
    expect(res.body).not.toHaveProperty('stripeProductId');
    expect(res.body).not.toHaveProperty('stripePriceId');
    expect(res.body).not.toHaveProperty('configured');
    expect(res.body).not.toHaveProperty('integrity');
  });

  it('OWNER can update Day Pass price; STAFF denied; creates one-time Stripe Price', async () => {
    const studio = await createStudio(prisma);
    const owner = await createUserWithPassword(prisma, {
      email: 'owner-daypass@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    const staff = await createUserWithPassword(prisma, {
      email: 'staff-daypass@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, staff.id, studio.id, Role.STAFF);
    const staffToken = await loginAccessToken(app, staff.email, staff.password);

    (stripe.createProductForPlan as jest.Mock).mockResolvedValue({ id: 'prod_day_pass_e2e' });
    (stripe.createOneTimePrice as jest.Mock).mockResolvedValue({
      id: 'price_day_pass_350',
      unit_amount: 35000,
      currency: 'mxn',
      active: true,
      recurring: null,
    });
    (stripe.retrievePrice as jest.Mock).mockResolvedValue({
      id: 'price_day_pass_350',
      unit_amount: 35000,
      currency: 'mxn',
      active: true,
      recurring: null,
      product: 'prod_day_pass_e2e',
    });

    await request(app.getHttpServer())
      .patch(`/api/v1/studios/${studio.id}/day-pass/settings`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ priceCents: 35000 })
      .expect(403);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/studios/${studio.id}/day-pass/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ priceCents: 35000, displayName: 'Pase diario' })
      .expect(200);

    expect(res.body).toEqual(
      expect.objectContaining({
        configured: true,
        priceCents: 35000,
        displayName: 'Pase diario',
        stripePriceId: 'price_day_pass_350',
      }),
    );

    const persisted = await prisma.studioDayPassSettings.findUniqueOrThrow({
      where: { studioId: studio.id },
    });
    expect(persisted.priceCents).toBe(35000);
    expect(persisted.stripePriceId).toBe('price_day_pass_350');
  });

  it('reconcile with no row bootstraps intentionally', async () => {
    const studio = await createStudio(prisma);
    const owner = await createUserWithPassword(prisma, {
      email: 'owner-reconcile-bootstrap@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    (stripe.createProductForPlan as jest.Mock).mockResolvedValue({ id: 'prod_reconcile' });
    (stripe.createOneTimePrice as jest.Mock).mockResolvedValue({ id: 'price_reconcile_200' });
    (stripe.retrievePrice as jest.Mock).mockResolvedValue({
      id: 'price_reconcile_200',
      unit_amount: 20000,
      currency: 'mxn',
      active: true,
      recurring: null,
      product: 'prod_reconcile',
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/day-pass/reconcile-stripe-price`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(res.body.status).toBe('reconciled');
    expect(await prisma.studioDayPassSettings.count({ where: { studioId: studio.id } })).toBe(1);
  });

  it('reconcile mismatch updates pointer and checkout uses canonical price', async () => {
    const studio = await createStudio(prisma);
    await prisma.studioDayPassSettings.create({
      data: {
        studioId: studio.id,
        displayName: 'Day Pass',
        priceCents: 20000,
        currency: 'mxn',
        active: true,
        stripeProductId: 'prod_e2e',
        stripePriceId: 'price_stale_250',
      },
    });

    (stripe.retrievePrice as jest.Mock)
      .mockResolvedValueOnce({
        id: 'price_stale_250',
        unit_amount: 25000,
        currency: 'mxn',
        active: true,
        recurring: null,
        product: 'prod_e2e',
      })
      .mockResolvedValue({
        id: 'price_sync_200',
        unit_amount: 20000,
        currency: 'mxn',
        active: true,
        recurring: null,
        product: 'prod_e2e',
      });
    (stripe.createOneTimePrice as jest.Mock).mockResolvedValue({ id: 'price_sync_200' });

    const owner = await createUserWithPassword(prisma, {
      email: 'owner-reconcile-dp@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/day-pass/reconcile-stripe-price`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const member = await createUserWithPassword(prisma, {
      email: 'member-daypass@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const memberToken = await loginAccessToken(app, member.email, member.password);

    (stripe.createOrRetrieveCustomer as jest.Mock).mockResolvedValue({ id: 'cus_e2e_daypass' });
    (stripe.createPaymentIntent as jest.Mock).mockResolvedValue({
      id: 'pi_e2e_daypass',
      client_secret: 'pi_secret',
    });
    (stripe.createEphemeralKey as jest.Mock).mockResolvedValue({ secret: 'ek_secret' });

    const today = new Date().toISOString().slice(0, 10);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/day-passes/payment-sheet`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ validForDate: today })
      .expect(201);

    expect(stripe.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 20000,
        currency: 'mxn',
        metadata: expect.objectContaining({ stripePriceId: 'price_sync_200' }),
      }),
    );
  });

  it('active=false blocks new checkout but keeps existing Day Pass rows', async () => {
    const studio = await createStudio(prisma);
    const member = await createUserWithPassword(prisma, {
      email: 'member-inactive@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const memberToken = await loginAccessToken(app, member.email, member.password);

    const existingPass = await prisma.dayPass.create({
      data: {
        studioId: studio.id,
        userId: member.id,
        validForDate: new Date('2026-06-10T06:00:00.000Z'),
        priceCents: 20000,
        currency: 'mxn',
        status: 'ACTIVE',
        stripePaymentIntentId: 'pi_existing',
      },
    });

    await prisma.studioDayPassSettings.create({
      data: {
        studioId: studio.id,
        displayName: 'Day Pass',
        priceCents: 20000,
        currency: 'mxn',
        active: false,
        stripeProductId: 'prod_e2e',
        stripePriceId: 'price_200',
      },
    });

    const today = new Date().toISOString().slice(0, 10);
    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/day-passes/payment-sheet`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ validForDate: today })
      .expect(400);

    const unchanged = await prisma.dayPass.findUniqueOrThrow({ where: { id: existingPass.id } });
    expect(unchanged.status).toBe('ACTIVE');
    expect(unchanged.priceCents).toBe(20000);
  });

  it('inactive catalog is not advertised as purchasable', async () => {
    const studio = await createStudio(prisma, { slug: 'day-pass-inactive-e2e' });
    await prisma.studioDayPassSettings.create({
      data: {
        studioId: studio.id,
        displayName: 'Day Pass',
        priceCents: 20000,
        currency: 'mxn',
        active: false,
        stripeProductId: 'prod_e2e',
        stripePriceId: 'price_200',
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/public/studios/${studio.slug}/day-pass`)
      .expect(200);

    expect(res.body.active).toBe(false);
  });

  it('Stripe failure leaves persisted catalog price unchanged', async () => {
    const studio = await createStudio(prisma);
    await prisma.studioDayPassSettings.create({
      data: {
        studioId: studio.id,
        displayName: 'Day Pass',
        priceCents: 20000,
        currency: 'mxn',
        active: true,
        stripeProductId: 'prod_e2e',
        stripePriceId: 'price_old_200',
      },
    });

    const owner = await createUserWithPassword(prisma, {
      email: 'owner-stripe-fail@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    (stripe.createOneTimePrice as jest.Mock).mockRejectedValue(new Error('stripe down'));

    await request(app.getHttpServer())
      .patch(`/api/v1/studios/${studio.id}/day-pass/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ priceCents: 30000 })
      .expect(400);

    const persisted = await prisma.studioDayPassSettings.findUniqueOrThrow({
      where: { studioId: studio.id },
    });
    expect(persisted.priceCents).toBe(20000);
    expect(persisted.stripePriceId).toBe('price_old_200');
  });

  it('historical Day Pass purchase rows remain unchanged after price update', async () => {
    const studio = await createStudio(prisma);
    const member = await createUserWithPassword(prisma, {
      email: 'member-hist@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);

    const historical = await prisma.dayPass.create({
      data: {
        studioId: studio.id,
        userId: member.id,
        validForDate: new Date('2026-06-10T06:00:00.000Z'),
        priceCents: 20000,
        currency: 'mxn',
        status: 'ACTIVE',
        stripePaymentIntentId: 'pi_historical',
      },
    });

    await prisma.studioDayPassSettings.create({
      data: {
        studioId: studio.id,
        displayName: 'Day Pass',
        priceCents: 20000,
        currency: 'mxn',
        active: true,
        stripeProductId: 'prod_e2e',
        stripePriceId: 'price_old_200',
      },
    });

    const owner = await createUserWithPassword(prisma, {
      email: 'owner-hist@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const ownerToken = await loginAccessToken(app, owner.email, owner.password);

    (stripe.createOneTimePrice as jest.Mock).mockResolvedValue({ id: 'price_new_350' });
    (stripe.retrievePrice as jest.Mock).mockResolvedValue({
      id: 'price_new_350',
      unit_amount: 35000,
      currency: 'mxn',
      active: true,
      recurring: null,
      product: 'prod_e2e',
    });

    await request(app.getHttpServer())
      .patch(`/api/v1/studios/${studio.id}/day-pass/settings`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ priceCents: 35000 })
      .expect(200);

    const unchanged = await prisma.dayPass.findUniqueOrThrow({ where: { id: historical.id } });
    expect(unchanged.priceCents).toBe(20000);
    expect(unchanged.stripePaymentIntentId).toBe('pi_historical');
  });
});
