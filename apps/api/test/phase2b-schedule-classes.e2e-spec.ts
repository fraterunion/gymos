import type { INestApplication } from '@nestjs/common';
import { ClassStatus, Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createClassTemplate,
  createMembership,
  createScheduledClass,
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

const rangeFrom = '2030-01-01T00:00:00.000Z';
const rangeTo = '2030-12-31T23:59:59.000Z';

describe('Phase 2B class templates and schedule (e2e)', () => {
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

  it('allows MEMBER to GET schedule in range', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'member-cal@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: new Date('2030-06-01T15:00:00.000Z'),
      endsAt: new Date('2030-06-01T16:00:00.000Z'),
    });
    const token = await loginAccessToken(app, email, password);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule`)
      .query({ from: rangeFrom, to: rangeTo })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
  });

  it('denies MEMBER POST /schedule', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'member-post@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/schedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: tpl.id,
        startTime: '2030-07-01T10:00:00.000Z',
        endTime: '2030-07-01T11:00:00.000Z',
      })
      .expect(403);
  });

  it('allows STAFF to POST /schedule', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'staff-post@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.STAFF);
    const token = await loginAccessToken(app, email, password);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/schedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: tpl.id,
        startTime: '2030-07-02T10:00:00.000Z',
        endTime: '2030-07-02T11:00:00.000Z',
      })
      .expect(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe(ClassStatus.SCHEDULED);
  });

  it('denies GET class-templates for studio without membership (cross-tenant)', async () => {
    const studioA = await createStudio(prisma);
    const studioB = await createStudio(prisma);
    await createClassTemplate(prisma, studioA.id, { name: 'A-only' });
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'cross-tpl@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studioB.id, Role.MEMBER);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studioA.id}/class-templates`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('does not list soft-deleted class templates', async () => {
    const studio = await createStudio(prisma);
    const active = await createClassTemplate(prisma, studio.id, { name: 'ActiveTpl' });
    const gone = await createClassTemplate(prisma, studio.id, { name: 'GoneTpl' });
    await prisma.classTemplate.update({
      where: { id: gone.id },
      data: { deletedAt: new Date() },
    });
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'tpl-list@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    const token = await loginAccessToken(app, email, password);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/class-templates`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ids = (res.body as { id: string }[]).map((t) => t.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(gone.id);
  });

  it('returns 404 when creating schedule with template from another studio', async () => {
    const studioA = await createStudio(prisma);
    const studioB = await createStudio(prisma);
    const tplA = await createClassTemplate(prisma, studioA.id);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'wrong-tpl@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studioB.id, Role.STAFF);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studioB.id}/schedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: tplA.id,
        startTime: '2030-08-01T10:00:00.000Z',
        endTime: '2030-08-01T11:00:00.000Z',
      })
      .expect(404);
  });

  it('returns 400 when startTime is not before endTime', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'bad-range@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.STAFF);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/schedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: tpl.id,
        startTime: '2030-09-01T12:00:00.000Z',
        endTime: '2030-09-01T10:00:00.000Z',
      })
      .expect(400);
  });

  it('allows OWNER to DELETE (cancel) a scheduled class', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { id: ownerId, email, password } = await createUserWithPassword(prisma, {
      email: 'owner-del@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, ownerId, studio.id, Role.OWNER);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: new Date('2030-10-01T14:00:00.000Z'),
      endsAt: new Date('2030-10-01T15:00:00.000Z'),
    });
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .delete(`/api/v1/studios/${studio.id}/schedule/${cls.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ cancelReason: 'Low enrollment' })
      .expect(204);

    const updated = await prisma.scheduledClass.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe(ClassStatus.CANCELLED);
    expect(updated.cancelReason).toBe('Low enrollment');

    const listRes = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule`)
      .query({ from: rangeFrom, to: rangeTo })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ids = (listRes.body as { id: string }[]).map((row) => row.id);
    expect(ids).not.toContain(cls.id);
  });

  it('allows FRONT_DESK to GET scheduled class by id without date gate', async () => {
    const studio = await createStudio(prisma);
    const tpl = await createClassTemplate(prisma, studio.id);
    const { id: deskId, email, password } = await createUserWithPassword(prisma, {
      email: 'desk-class-by-id@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, deskId, studio.id, Role.FRONT_DESK);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: new Date('2031-03-15T14:00:00.000Z'),
      endsAt: new Date('2031-03-15T15:00:00.000Z'),
    });
    const token = await loginAccessToken(app, email, password);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule/${cls.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as { id: string; bookedCount: number; waitlistCount: number; checkedInCount: number };
    expect(body.id).toBe(cls.id);
    expect(body.bookedCount).toBe(0);
    expect(body.waitlistCount).toBe(0);
    expect(body.checkedInCount).toBe(0);
  });
});
