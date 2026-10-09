import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createMembership,
  createStudio,
  createUserWithPassword,
} from './helpers/factories';

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

describe('GET /analytics/executive authorization (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function tokenForRole(role: Role, studioId: string, email: string) {
    const { id: userId, email: e, password } = await createUserWithPassword(prisma, {
      email,
      password: 'password12',
    });
    await createMembership(prisma, userId, studioId, role);
    return loginAccessToken(app, e, password);
  }

  it('OWNER → 200', async () => {
    const studio = await createStudio(prisma);
    const token = await tokenForRole(Role.OWNER, studio.id, 'owner-exec@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/executive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('ADMIN → 200', async () => {
    const studio = await createStudio(prisma);
    const token = await tokenForRole(Role.ADMIN, studio.id, 'admin-exec@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/executive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('STAFF → 403', async () => {
    const studio = await createStudio(prisma);
    const token = await tokenForRole(Role.STAFF, studio.id, 'staff-exec@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/executive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('FRONT_DESK → 403', async () => {
    const studio = await createStudio(prisma);
    const token = await tokenForRole(Role.FRONT_DESK, studio.id, 'fd-exec@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/executive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('INSTRUCTOR → 403', async () => {
    const studio = await createStudio(prisma);
    const token = await tokenForRole(Role.INSTRUCTOR, studio.id, 'instr-exec@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/executive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('MEMBER → 403', async () => {
    const studio = await createStudio(prisma);
    const token = await tokenForRole(Role.MEMBER, studio.id, 'member-exec@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/executive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('cross-studio access → 403', async () => {
    const studioA = await createStudio(prisma);
    const studioB = await createStudio(prisma);
    const token = await tokenForRole(Role.OWNER, studioA.id, 'owner-a@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studioB.id}/analytics/executive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});

describe('GET /analytics/executive — cancellation attribution (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  it('splits last-30-day cancellations into voluntary, involuntary and superseded by end reason (totals unchanged)', async () => {
    const studio = await createStudio(prisma);
    const owner = await createUserWithPassword(prisma, { email: 'owner-churn@e2e.local', password: 'password12' });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const plan = await prisma.membershipPlan.create({ data: { studioId: studio.id, name: 'Full Access', priceCents: 150000, currency: 'mxn', billingInterval: 'MONTHLY' } });
    const reasons = ['MEMBER_CANCELLED', 'STAFF_CANCELLED', 'PAYMENT_FAILED', 'PAYMENT_DISPUTED', 'INCOMPLETE_EXPIRED', 'SUPERSEDED_RENEWAL', null] as const;
    for (const [i, endReason] of reasons.entries()) {
      const member = await createUserWithPassword(prisma, { email: `churn-${i}@e2e.local` });
      await createMembership(prisma, member.id, studio.id, Role.MEMBER);
      await prisma.subscription.create({ data: { studioId: studio.id, userId: member.id, membershipPlanId: plan.id, status: 'CANCELED', source: endReason === 'SUPERSEDED_RENEWAL' ? 'CASH' : 'STRIPE', endReason, stripeSubscriptionId: endReason === 'SUPERSEDED_RENEWAL' ? null : `sub_churn_${i}` } });
    }
    const token = await loginAccessToken(app, owner.email, owner.password);
    const res = await request(app.getHttpServer()).get(`/api/v1/studios/${studio.id}/analytics/executive`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.membershipHealth).toMatchObject({
      cancelledThisMonth: 7,
      cancellationsBreakdown: { voluntary: 2, involuntary: 3, superseded: 1, unknown: 1 },
    });
  });
});
