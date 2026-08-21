import type { INestApplication } from '@nestjs/common';
import { ClassStatus, Role } from '@prisma/client';
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

describe('Member Analytics (e2e)', () => {
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

  it('OWNER can read member analytics summary', async () => {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const token = await tokenForRole(Role.OWNER, studio.id, 'owner-ma@e2e.local');

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/members/summary?period=this_month`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.kpis).toBeDefined();
    expect(res.body.timezone).toBe('America/Mexico_City');
  });

  it('STAFF is forbidden from member analytics', async () => {
    const studio = await createStudio(prisma);
    const token = await tokenForRole(Role.STAFF, studio.id, 'staff-ma@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/members/summary`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('MEMBER role cannot access member analytics', async () => {
    const studio = await createStudio(prisma);
    const token = await tokenForRole(Role.MEMBER, studio.id, 'member-ma@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/members`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('counts member attendance in studio timezone month', async () => {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const ownerToken = await tokenForRole(Role.OWNER, studio.id, 'owner-ma2@e2e.local');
    const { id: memberId } = await createUserWithPassword(prisma, {
      email: 'member-att@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, memberId, studio.id, Role.MEMBER);

    const template = await createClassTemplate(prisma, studio.id, { name: 'Pull' });
    const scheduled = await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: template.id,
        startsAt: new Date('2026-08-15T12:00:00.000Z'),
        endsAt: new Date('2026-08-15T13:00:00.000Z'),
        capacity: 12,
        status: ClassStatus.SCHEDULED,
      },
    });
    await prisma.attendance.create({
      data: {
        studioId: studio.id,
        scheduledClassId: scheduled.id,
        userId: memberId,
        checkedInAt: new Date('2026-08-15T12:05:00.000Z'),
        method: 'MANUAL',
      },
    });

    const summary = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/members/summary?period=this_month`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(summary.body.kpis.attendances).toBeGreaterThanOrEqual(1);
    expect(summary.body.kpis.membersAttended).toBeGreaterThanOrEqual(1);
  });

  it('uses class startsAt for favorite schedule time, not check-in drift', async () => {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const ownerToken = await tokenForRole(Role.OWNER, studio.id, 'owner-ma3@e2e.local');
    const { id: memberId } = await createUserWithPassword(prisma, {
      email: 'member-sched@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, memberId, studio.id, Role.MEMBER);
    const template = await createClassTemplate(prisma, studio.id, { name: 'Morning Pull' });
    const scheduled = await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: template.id,
        startsAt: new Date('2026-08-18T13:00:00.000Z'), // 07:00 CDMX
        endsAt: new Date('2026-08-18T14:00:00.000Z'),
        capacity: 12,
        status: ClassStatus.SCHEDULED,
      },
    });
    await prisma.attendance.create({
      data: {
        studioId: studio.id,
        scheduledClassId: scheduled.id,
        userId: memberId,
        checkedInAt: new Date('2026-08-18T13:03:00.000Z'),
        method: 'MANUAL',
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/members/${memberId}?period=this_month`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(detail.body.favoriteTime).toBe('07:00');
    expect(detail.body.favoriteClass).toBe('Morning Pull');
  });
});
