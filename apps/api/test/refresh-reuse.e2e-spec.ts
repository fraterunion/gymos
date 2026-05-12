import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';

describe('Refresh reuse (e2e)', () => {
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

  it('replaying an old refresh after rotation revokes family', async () => {
    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'reuse@e2e.local',
        firstName: 'R',
        lastName: 'U',
        password: 'password12',
      })
      .expect(201);

    const rt1 = (reg.body as { refreshToken: string }).refreshToken;

    const first = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rt1 })
      .expect(201);
    const rt2 = (first.body as { refreshToken: string }).refreshToken;

    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: rt1 }).expect(401);

    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: rt2 }).expect(401);
  });
});
