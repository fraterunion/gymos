import type { INestApplication } from '@nestjs/common';
import { BillingInterval, MembershipPriceChangeScope, Role, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { StripeService } from '../src/stripe/stripe.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';

/**
 * Exercise the real HTTP guards, real Postgres transactions and the full
 * grandfathering service against the disposable gymos_test e2e database.
 * The shared test app mocks StripeService: absolutely no live Stripe writes.
 */
describe('ARES / optional price grandfathering (e2e, isolated)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: StripeService;
  const stripePriceUpdate = jest.fn();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    stripe = app.get(StripeService);
    // The shared e2e mock intentionally omits price-update writes by default.
    // An explicit spy turns any unexpected attempt into an observable failure.
    Object.assign(stripe, { updateSubscription: stripePriceUpdate });
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  async function seed(planName: string) {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const owner = await createUserWithPassword(prisma);
    const memberA = await createUserWithPassword(prisma);
    const memberB = await createUserWithPassword(prisma);
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    await createMembership(prisma, memberA.id, studio.id, Role.MEMBER);
    await createMembership(prisma, memberB.id, studio.id, Role.MEMBER);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: owner.email, password: owner.password })
      .expect(201);
    const ownerToken = (login.body as { accessToken: string }).accessToken;

    const plan = await prisma.membershipPlan.create({
      data: {
        studioId: studio.id,
        name: planName,
        priceCents: 100000,
        currency: 'mxn',
        billingInterval: BillingInterval.MONTHLY,
        active: true,
      },
    });
    const startsAt = new Date(Date.now() - 86_400_000);
    const endsAt = new Date(Date.now() + 30 * 86_400_000);
    const createCash = (userId: string) => prisma.subscription.create({
      data: {
        studioId: studio.id,
        userId,
        membershipPlanId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.CASH,
        priceCents: 100000,
        currentPeriodStart: startsAt,
        currentPeriodEnd: endsAt,
      },
    });
    const [subA, subB] = await Promise.all([
      createCash(memberA.id),
      createCash(memberB.id),
    ]);
    const url = `/api/v1/studios/${studio.id}/membership-plans/${plan.id}/price-changes`;
    return { studio, owner, memberA, memberB, plan, subA, subB, ownerToken, url };
  }

  async function prices(planId: string) {
    const [plan, subscriptions] = await Promise.all([
      prisma.membershipPlan.findUniqueOrThrow({ where: { id: planId } }),
      prisma.subscription.findMany({
        where: { membershipPlanId: planId },
        orderBy: { id: 'asc' },
        select: { id: true, priceCents: true },
      }),
    ]);
    return { catalog: plan.priceCents, locks: new Map(subscriptions.map((row) => [row.id, row.priceCents])) };
  }

  it('preview and missing confirmation cannot modify existing Basic memberships', async () => {
    const f = await seed('Basic Access');
    const initial = await prices(f.plan.id);
    const preview = await request(app.getHttpServer())
      .post(`${f.url}/preview`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ newPriceCents: 150000 })
      .expect(200);
    expect(preview.body.counts).toMatchObject({ total: 2, wouldChange: 2 });
    expect(preview.body.members).toHaveLength(2);

    await request(app.getHttpServer())
      .post(f.url)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        scope: MembershipPriceChangeScope.ALL_EXISTING,
        newPriceCents: 150000,
        idempotencyKey: 'unconfirmed-basic-ares',
        confirm: false,
      })
      .expect(400);

    const after = await prices(f.plan.id);
    expect(after.catalog).toBe(initial.catalog);
    expect([...after.locks]).toEqual([...initial.locks]);
    expect(await prisma.membershipPriceChange.count()).toBe(0);
    expect(stripePriceUpdate).not.toHaveBeenCalled();
  });

  it('Basic FUTURE_ONLY changes the catalog, never existing members or Stripe', async () => {
    const f = await seed('Basic Access');
    const result = await request(app.getHttpServer())
      .post(f.url)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        scope: MembershipPriceChangeScope.FUTURE_ONLY,
        newPriceCents: 150000,
        idempotencyKey: 'basic-future-only',
        confirm: true,
      })
      .expect(200);
    expect(result.body.status).toBe('COMPLETED');
    const after = await prices(f.plan.id);
    expect(after.catalog).toBe(150000);
    expect(after.locks.get(f.subA.id)).toBe(100000);
    expect(after.locks.get(f.subB.id)).toBe(100000);
    const items = await prisma.membershipPriceChangeItem.findMany({
      where: { priceChangeId: result.body.id as string },
    });
    expect(items).toHaveLength(2);
    expect(items.every((item) => !item.applyNewPrice && item.status === 'SKIPPED')).toBe(true);
    expect(stripePriceUpdate).not.toHaveBeenCalled();
  });

  it('Full SELECTED changes only chosen member and denies altered idempotent replay', async () => {
    const f = await seed('Full Access');
    const requestBody = {
      scope: MembershipPriceChangeScope.SELECTED,
      newPriceCents: 195000,
      subscriptionIds: [f.subA.id],
      idempotencyKey: 'full-custom-selected',
      confirm: true,
    };
    const first = await request(app.getHttpServer())
      .post(f.url)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(requestBody)
      .expect(200);
    expect(first.body.status).toBe('COMPLETED');
    const after = await prices(f.plan.id);
    expect(after.catalog).toBe(195000);
    expect(after.locks.get(f.subA.id)).toBe(195000);
    expect(after.locks.get(f.subB.id)).toBe(100000);

    const replay = await request(app.getHttpServer())
      .post(f.url)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send(requestBody)
      .expect(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.idempotentReplay).toBe(true);

    await request(app.getHttpServer())
      .post(f.url)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ ...requestBody, subscriptionIds: [f.subB.id] })
      .expect(409);
    const unchanged = await prices(f.plan.id);
    expect(unchanged.locks.get(f.subA.id)).toBe(195000);
    expect(unchanged.locks.get(f.subB.id)).toBe(100000);
    expect(await prisma.membershipPriceChange.count()).toBe(1);
    expect(stripePriceUpdate).not.toHaveBeenCalled();
  });

  it('Pro ALL_EXISTING changes only the confirmed plan and no unrelated plan', async () => {
    const f = await seed('Pro Access');
    const other = await prisma.membershipPlan.create({
      data: {
        studioId: f.studio.id,
        name: 'Full Access',
        priceCents: 250000,
        currency: 'mxn',
        billingInterval: BillingInterval.MONTHLY,
        active: true,
      },
    });
    const otherSub = await prisma.subscription.create({
      data: {
        studioId: f.studio.id,
        userId: f.memberA.id,
        membershipPlanId: other.id,
        status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.CASH,
        priceCents: 250000,
        currentPeriodStart: new Date(Date.now() - 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    const result = await request(app.getHttpServer())
      .post(f.url)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({
        scope: MembershipPriceChangeScope.ALL_EXISTING,
        newPriceCents: 125000,
        idempotencyKey: 'pro-all-existing',
        confirm: true,
      })
      .expect(200);
    expect(result.body.status).toBe('COMPLETED');
    const after = await prices(f.plan.id);
    expect(after.catalog).toBe(125000);
    expect(after.locks.get(f.subA.id)).toBe(125000);
    expect(after.locks.get(f.subB.id)).toBe(125000);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: otherSub.id } })).priceCents).toBe(250000);
    expect((await prisma.membershipPlan.findUniqueOrThrow({ where: { id: other.id } })).priceCents).toBe(250000);
    expect(stripePriceUpdate).not.toHaveBeenCalled();
  });
});
