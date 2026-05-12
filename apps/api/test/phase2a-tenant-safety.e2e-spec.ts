import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
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

describe('Phase 2A tenant and role safety (e2e)', () => {
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

  it('denies MEMBER PATCH /studios/:studioId (admin-only mutation)', async () => {
    const studio = await createStudio(prisma);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'member-patch@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .patch(`/api/v1/studios/${studio.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hijacked Name' })
      .expect(403);
  });

  it('denies user with membership only in studio B from GET /studios/:studioId of studio A', async () => {
    const studioA = await createStudio(prisma);
    const studioB = await createStudio(prisma);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'cross-tenant@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studioB.id, Role.MEMBER);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studioA.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('denies GET /studios/:studioId when studio is soft-deleted', async () => {
    const studio = await createStudio(prisma);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'soft-studio@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    await prisma.studio.update({
      where: { id: studio.id },
      data: { deletedAt: new Date() },
    });
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('allows STAFF GET /studios/:studioId/members', async () => {
    const studio = await createStudio(prisma);
    const { id: staffUserId, email, password } = await createUserWithPassword(prisma, {
      email: 'staff-list@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, staffUserId, studio.id, Role.STAFF);
    const token = await loginAccessToken(app, email, password);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/members`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('denies MEMBER GET /studios/:studioId/members', async () => {
    const studio = await createStudio(prisma);
    const { id: userId, email, password } = await createUserWithPassword(prisma, {
      email: 'member-list@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    const token = await loginAccessToken(app, email, password);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/members`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
