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

describe('Branding (e2e)', () => {
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

  it('GET public branding returns safe fields by slug', async () => {
    const studio = await createStudio(prisma, { slug: 'wl-brand-a', name: 'Brand A Gym' });
    await prisma.studio.update({
      where: { id: studio.id },
      data: {
        appName: 'Brand A',
        brandPrimaryColor: '#112233',
        supportEmail: 'support@branda.test',
      },
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/public/studios/wl-brand-a/branding')
      .expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body.slug).toBe('wl-brand-a');
    expect(body.name).toBe('Brand A Gym');
    expect(body.appName).toBe('Brand A');
    expect(body.brandPrimaryColor).toBe('#112233');
    expect(body.supportEmail).toBe('support@branda.test');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('deletedAt');
    expect(raw).not.toContain('passwordHash');
    expect(body.id).toBeUndefined();
  });

  it('GET public branding returns 404 for deleted studio', async () => {
    const studio = await createStudio(prisma, { slug: 'wl-deleted' });
    await prisma.studio.update({
      where: { id: studio.id },
      data: { deletedAt: new Date() },
    });

    await request(app.getHttpServer())
      .get('/api/v1/public/studios/wl-deleted/branding')
      .expect(404);
  });

  it('forbids MEMBER from reading or updating branding', async () => {
    const studio = await createStudio(prisma, { slug: 'wl-member' });
    const u = await createUserWithPassword(prisma, { email: 'mem-brand@e2e.local' });
    await createMembership(prisma, u.id, studio.id, Role.MEMBER);
    const token = await loginAccessToken(app, u.email, u.password);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/branding`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/api/v1/studios/${studio.id}/branding`)
      .set('Authorization', `Bearer ${token}`)
      .send({ appName: 'X' })
      .expect(403);
  });

  it('allows ADMIN to read and update branding', async () => {
    const studio = await createStudio(prisma, { slug: 'wl-admin' });
    const admin = await createUserWithPassword(prisma, { email: 'adm-brand@e2e.local' });
    await createMembership(prisma, admin.id, studio.id, Role.ADMIN);
    const token = await loginAccessToken(app, admin.email, admin.password);

    const get = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/branding`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((get.body as { id: string }).id).toBe(studio.id);

    const patch = await request(app.getHttpServer())
      .patch(`/api/v1/studios/${studio.id}/branding`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        appName: 'Admin App',
        brandPrimaryColor: 'aabbcc',
        privacyUrl: 'https://example.com/privacy',
        iosBundleId: 'com.example.brand',
        androidPackageName: 'com.example.brand',
      })
      .expect(200);
    const b = patch.body as { appName: string; brandPrimaryColor: string };
    expect(b.appName).toBe('Admin App');
    expect(b.brandPrimaryColor).toBe('#aabbcc');
  });

  it('allows OWNER to update branding', async () => {
    const studio = await createStudio(prisma, { slug: 'wl-owner' });
    const owner = await createUserWithPassword(prisma, { email: 'own-brand@e2e.local' });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const token = await loginAccessToken(app, owner.email, owner.password);

    await request(app.getHttpServer())
      .patch(`/api/v1/studios/${studio.id}/branding`)
      .set('Authorization', `Bearer ${token}`)
      .send({ supportPhone: '+1 555 0100' })
      .expect(200);
  });

  it('rejects invalid hex color', async () => {
    const studio = await createStudio(prisma, { slug: 'wl-hex' });
    const admin = await createUserWithPassword(prisma, { email: 'hex@e2e.local' });
    await createMembership(prisma, admin.id, studio.id, Role.ADMIN);
    const token = await loginAccessToken(app, admin.email, admin.password);

    await request(app.getHttpServer())
      .patch(`/api/v1/studios/${studio.id}/branding`)
      .set('Authorization', `Bearer ${token}`)
      .send({ brandPrimaryColor: 'not-hex' })
      .expect(400);
  });

  it('rejects invalid URL', async () => {
    const studio = await createStudio(prisma, { slug: 'wl-url' });
    const admin = await createUserWithPassword(prisma, { email: 'url@e2e.local' });
    await createMembership(prisma, admin.id, studio.id, Role.ADMIN);
    const token = await loginAccessToken(app, admin.email, admin.password);

    await request(app.getHttpServer())
      .patch(`/api/v1/studios/${studio.id}/branding`)
      .set('Authorization', `Bearer ${token}`)
      .send({ brandLogoUrl: 'not-a-valid-url' })
      .expect(400);
  });

  it('denies cross-studio branding access', async () => {
    const a = await createStudio(prisma, { slug: 'wl-a' });
    const b = await createStudio(prisma, { slug: 'wl-b' });
    const admin = await createUserWithPassword(prisma, { email: 'cross@e2e.local' });
    await createMembership(prisma, admin.id, a.id, Role.ADMIN);
    const token = await loginAccessToken(app, admin.email, admin.password);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${b.id}/branding`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
