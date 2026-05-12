import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';

describe('Soft-delete auth (e2e)', () => {
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

  it('rejects login for soft-deleted user', async () => {
    const u = await createUserWithPassword(prisma, {
      email: 'gone@e2e.local',
      password: 'password12',
    });
    await prisma.user.update({
      where: { id: u.id },
      data: { deletedAt: new Date() },
    });

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'gone@e2e.local', password: 'password12' })
      .expect(401);
  });

  it('rejects studio verify when membership is soft-deleted', async () => {
    const studio = await createStudio(prisma);
    const { id: userId, password, email } = await createUserWithPassword(prisma, {
      email: 'mem@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, userId, studio.id, Role.MEMBER);
    await prisma.studioMembership.updateMany({
      where: { userId, studioId: studio.id },
      data: { deletedAt: new Date() },
    });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);

    const token = (login.body as { accessToken: string }).accessToken;

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/verify`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
