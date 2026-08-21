import type { INestApplication } from '@nestjs/common';
import { ClassStatus, Role, SubscriptionStatus, SubscriptionSource } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createClassTemplate,
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

describe('Retention Analytics 1.1 (e2e)', () => {
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
    return { token: await loginAccessToken(app, e, password), userId };
  }

  async function entitledMember(
    studioId: string,
    email: string,
    planId: string,
  ) {
    const { id: userId } = await createUserWithPassword(prisma, {
      email,
      password: 'password12',
    });
    await createMembership(prisma, userId, studioId, Role.MEMBER);
    await prisma.subscription.create({
      data: {
        studioId,
        userId,
        membershipPlanId: planId,
        status: SubscriptionStatus.ACTIVE,
        source: SubscriptionSource.CASH,
        currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2027-01-01T00:00:00.000Z'),
      },
    });
    return userId;
  }

  it('OWNER and ADMIN can read retention summary; STAFF/MEMBER forbidden', async () => {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const { token: owner } = await tokenForRole(Role.OWNER, studio.id, 'own-ret@e2e.local');
    const { token: admin } = await tokenForRole(Role.ADMIN, studio.id, 'adm-ret@e2e.local');
    const { token: staff } = await tokenForRole(Role.STAFF, studio.id, 'stf-ret@e2e.local');
    const { token: member } = await tokenForRole(Role.MEMBER, studio.id, 'mem-ret@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/retention/summary`)
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/retention/activity`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/retention/summary`)
      .set('Authorization', `Bearer ${staff}`)
      .expect(403);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/retention/members`)
      .set('Authorization', `Bearer ${member}`)
      .expect(403);
  });

  it('separates entitled inactive from lapsed and detects recency at-risk', async () => {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const { token } = await tokenForRole(Role.OWNER, studio.id, 'own-ret2@e2e.local');
    const plan = await prisma.membershipPlan.create({
      data: {
        studioId: studio.id,
        name: 'Full',
        priceCents: 1000,
        currency: 'mxn',
        billingInterval: 'MONTHLY',
      },
    });
    const tpl = await createClassTemplate(prisma, studio.id, { name: 'Push' });

    const inactiveId = await entitledMember(studio.id, 'inactive@e2e.local', plan.id);
    const atRiskId = await entitledMember(studio.id, 'atrisk@e2e.local', plan.id);
    const lapsedId = await createUserWithPassword(prisma, {
      email: 'lapsed@e2e.local',
      password: 'password12',
    }).then(async (u) => {
      await createMembership(prisma, u.id, studio.id, Role.MEMBER);
      return u.id;
    });

    const cls = await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: tpl.id,
        startsAt: new Date('2026-08-01T13:00:00.000Z'),
        endsAt: new Date('2026-08-01T14:00:00.000Z'),
        capacity: 10,
        status: ClassStatus.SCHEDULED,
      },
    });
    // ~16 days before "now" if tests run mid/late Aug 2026 — use relative now
    const sixteenDaysAgo = new Date(Date.now() - 16 * 86_400_000);
    await prisma.attendance.create({
      data: {
        studioId: studio.id,
        userId: atRiskId,
        scheduledClassId: cls.id,
        checkedInAt: sixteenDaysAgo,
        method: 'MANUAL',
      },
    });
    void inactiveId;
    void lapsedId;

    const summary = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/retention/summary`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(summary.body.kpis.activeMembers).toBeGreaterThanOrEqual(2);
    expect(summary.body.populations.lapsed).toBeGreaterThanOrEqual(1);

    const members = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/retention/members?entitlement=all`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const atRisk = (members.body.data as Array<{ userId: string; health: string }>).find(
      (m) => m.userId === atRiskId,
    );
    const inactive = (members.body.data as Array<{ userId: string; health: string }>).find(
      (m) => m.userId === inactiveId,
    );
    const lapsed = (members.body.data as Array<{ userId: string; health: string }>).find(
      (m) => m.userId === lapsedId,
    );

    expect(atRisk?.health).toBe('AT_RISK');
    expect(inactive?.health).toBe('INACTIVE');
    expect(lapsed?.health).toBe('LAPSED');

    const activity = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/retention/activity`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const actionIds = (activity.body.requiresAction as Array<{ userId: string }>).map(
      (m) => m.userId,
    );
    expect(actionIds).toContain(atRiskId);
    expect(actionIds).not.toContain(lapsedId);
  });

  it('isolates studios and suppresses tiny class stickiness samples', async () => {
    const studioA = await createStudio(prisma, { timezone: 'America/Mexico_City', slug: 'ret-a' });
    const studioB = await createStudio(prisma, { timezone: 'America/Mexico_City', slug: 'ret-b' });
    const { token } = await tokenForRole(Role.OWNER, studioA.id, 'own-iso@e2e.local');
    await tokenForRole(Role.OWNER, studioB.id, 'own-iso-b@e2e.local');

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studioA.id}/analytics/retention/activity`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.classStickiness).toEqual([]);
    expect(Array.isArray(res.body.cohorts)).toBe(true);
  });
});
