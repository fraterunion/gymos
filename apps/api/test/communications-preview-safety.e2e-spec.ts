import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { signUnsubscribeToken } from '../src/communications/unsubscribe-token';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';

/**
 * ARES PR #5: real HTTP guards, transactional Postgres, and unsubscribe routes.
 * The DB is disposable gymos_test. Never use this file against a production DB.
 * The email worker is OFF; no Resend, Stripe or other real network writes.
 */
describe('ARES communications preview + unsubscribe safety (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const previousWorker = process.env['EMAIL_CAMPAIGN_WORKER'];
  const previousBase = process.env['EMAIL_UNSUBSCRIBE_URL_BASE'];

  beforeAll(async () => {
    process.env['EMAIL_CAMPAIGN_WORKER'] = '0';
    process.env['EMAIL_UNSUBSCRIBE_URL_BASE'] = 'https://ares-rehearsal.example.test';
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
    if (previousWorker === undefined) delete process.env['EMAIL_CAMPAIGN_WORKER'];
    else process.env['EMAIL_CAMPAIGN_WORKER'] = previousWorker;
    if (previousBase === undefined) delete process.env['EMAIL_UNSUBSCRIBE_URL_BASE'];
    else process.env['EMAIL_UNSUBSCRIBE_URL_BASE'] = previousBase;
  });

  async function seed() {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const owner = await createUserWithPassword(prisma);
    const memberA = await createUserWithPassword(prisma);
    const memberB = await createUserWithPassword(prisma);
    await Promise.all([
      createMembership(prisma, owner.id, studio.id, Role.OWNER),
      createMembership(prisma, memberA.id, studio.id, Role.MEMBER),
      createMembership(prisma, memberB.id, studio.id, Role.MEMBER),
    ]);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: owner.email, password: owner.password })
      .expect(201);
    const token = (login.body as { accessToken: string }).accessToken;
    const base = `/api/v1/studios/${studio.id}/communications`;
    return { studio, owner, memberA, memberB, token, base };
  }

  it('requires the exact reviewed audience and explicit confirmation before queuing any mail', async () => {
    const f = await seed();
    const preview = await request(app.getHttpServer())
      .post(`${f.base}/preview`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ allMembers: true })
      .expect(200);

    expect(preview.body.recipientCount).toBe(2);
    expect(preview.body.previewFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await prisma.emailCampaign.count()).toBe(0);

    const body = {
      allMembers: true,
      subject: 'Aviso de prueba ARES',
      bodyText: 'Contenido sin envíos reales.',
      idempotencyKey: 'ares-qa-preview-000001',
    };
    await request(app.getHttpServer())
      .post(`${f.base}/campaigns`)
      .set('Authorization', `Bearer ${f.token}`)
      .send(body)
      .expect(400);

    await request(app.getHttpServer())
      .post(`${f.base}/campaigns`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ ...body, previewFingerprint: '0'.repeat(64) })
      .expect(409);
    expect(await prisma.emailCampaign.count()).toBe(0);

    const created = await request(app.getHttpServer())
      .post(`${f.base}/campaigns`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ ...body, previewFingerprint: preview.body.previewFingerprint })
      .expect(201);
    const id = (created.body as { id: string }).id;
    expect(created.body.status).toBe('DRAFT');
    expect(await prisma.emailCampaign.count()).toBe(1);
    expect(await prisma.emailCampaignRecipient.count({ where: { campaignId: id } })).toBe(2);

    await request(app.getHttpServer())
      .post(`${f.base}/campaigns/${id}/confirm`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ confirm: false })
      .expect(400);
    expect((await prisma.emailCampaign.findUniqueOrThrow({ where: { id } })).status).toBe('DRAFT');

    const queued = await request(app.getHttpServer())
      .post(`${f.base}/campaigns/${id}/confirm`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ confirm: true })
      .expect(200);
    expect(queued.body.status).toBe('SENDING');
    expect(await prisma.emailCampaignRecipient.count({ where: { campaignId: id, status: 'SENT' } })).toBe(0);
  });

  it('rejects a snapshot if new members joined after preview', async () => {
    const f = await seed();
    const preview = await request(app.getHttpServer())
      .post(`${f.base}/preview`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ allMembers: true })
      .expect(200);

    const newcomer = await createUserWithPassword(prisma);
    await createMembership(prisma, newcomer.id, f.studio.id, Role.MEMBER);
    await request(app.getHttpServer())
      .post(`${f.base}/campaigns`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        allMembers: true,
        subject: 'Aviso',
        bodyText: 'No enviar si la audiencia cambió',
        idempotencyKey: 'ares-qa-preview-000002',
        previewFingerprint: preview.body.previewFingerprint,
      })
      .expect(409);
    expect(await prisma.emailCampaign.count()).toBe(0);
  });

  it('GET unsubscribe has zero side effects; only POST opts out the member', async () => {
    const f = await seed();
    const secret = process.env['JWT_SECRET'] || '';
    expect(secret.length).toBeGreaterThan(0);
    const token = signUnsubscribeToken({ studioId: f.studio.id, email: f.memberA.email }, secret);
    const unsubscribePath = `/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`;

    const page = await request(app.getHttpServer()).get(unsubscribePath).expect(200);
    expect(page.text).toContain('Confirmar baja');
    expect(await prisma.emailSuppression.count()).toBe(0);

    await request(app.getHttpServer())
      .post(unsubscribePath)
      .set('Accept', 'application/json')
      .send('List-Unsubscribe=One-Click')
      .expect(200);
    const entries = await prisma.emailSuppression.findMany();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.email).toBe(f.memberA.email.toLowerCase());

    await request(app.getHttpServer()).get(unsubscribePath).expect(200);
    expect(await prisma.emailSuppression.count()).toBe(1);
    await request(app.getHttpServer()).get('/api/v1/email/unsubscribe?token=invalid').expect(400);
  });
});
