import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createStudio } from './helpers/factories';

describe('Auth (e2e)', () => {
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

  it('GET /health is outside global prefix', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('register returns 201 without passwordHash', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'new@e2e.local',
        firstName: 'N',
        lastName: 'E',
        password: 'password12',
      })
      .expect(201);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  it('register without studioSlug does not create studio membership', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'nomembership@e2e.local',
        firstName: 'N',
        lastName: 'M',
        password: 'password12',
      })
      .expect(201);

    const studios = await request(app.getHttpServer())
      .get('/api/v1/me/studios')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
    expect(studios.body).toEqual([]);
  });

  it('register with valid studioSlug creates studio membership', async () => {
    const studio = await createStudio(prisma, { slug: 'reg-join-studio' });

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'joined@e2e.local',
        firstName: 'J',
        lastName: 'S',
        password: 'password12',
        studioSlug: studio.slug,
      })
      .expect(201);

    const studios = await request(app.getHttpServer())
      .get('/api/v1/me/studios')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
    expect(studios.body).toHaveLength(1);
    expect(studios.body[0].studio.slug).toBe(studio.slug);
    expect(studios.body[0].role).toBe(Role.MEMBER);

    const membership = await prisma.studioMembership.findFirst({
      where: { userId: res.body.user.id, studioId: studio.id },
    });
    expect(membership).not.toBeNull();
    expect(membership?.role).toBe(Role.MEMBER);
    expect(membership?.deletedAt).toBeNull();
  });

  it('register with invalid studioSlug returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'badslug@e2e.local',
        firstName: 'B',
        lastName: 'S',
        password: 'password12',
        studioSlug: 'does-not-exist',
      })
      .expect(400);
    expect(res.body.message).toBe('Studio not found');
  });

  it('login, refresh, me, logout flow', async () => {
    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'flow@e2e.local',
        firstName: 'F',
        lastName: 'L',
        password: 'password12',
      })
      .expect(201);

    const { refreshToken } = reg.body as { refreshToken: string; accessToken: string };

    const ref = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(201);
    expect(ref.body.refreshToken).toBeDefined();

    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${ref.body.accessToken}`)
      .expect(200);
    expect(me.body.email).toBe('flow@e2e.local');

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: ref.body.refreshToken })
      .expect(204);
  });
});

describe('Auth register throttle (e2e)', () => {
  let throttleApp: INestApplication;
  let throttlePrisma: PrismaService;

  beforeAll(async () => {
    throttleApp = await createTestApp();
    throttlePrisma = throttleApp.get(PrismaService);
    await truncateAll(throttlePrisma);
  });

  afterAll(async () => {
    await throttleApp.close();
  });

  it('returns 429 on the 6th POST /auth/register within one minute', async () => {
    for (let i = 0; i < 5; i++) {
      await request(throttleApp.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: `thr${i}@e2e.local`,
          firstName: 'T',
          lastName: 'H',
          password: 'password12',
        })
        .expect(201);
    }
    await request(throttleApp.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'thr5@e2e.local',
        firstName: 'T',
        lastName: 'H',
        password: 'password12',
      })
      .expect(429);
  });
});
