import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { CommunicationsService } from '../src/communications/communications.service';
import { EMAIL_PROVIDER, type EmailMessage, type EmailProvider } from '../src/email/email-provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';

/**
 * ARES campaign sender (2026-10-30): mass email from Communications goes out as
 * "ARES Training Club <fernando@arestrainingclub.com>" with Reply-To Fernando, through the real
 * HTTP flow (preview → create → confirm → delivery), while password recovery keeps the platform
 * sender. Paused delivery and stale queued campaigns never send on their own.
 */
describe('ARES campaign sender + delivery state (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let communications: CommunicationsService;
  let sendSpy: jest.SpyInstance<Promise<{ providerMessageId: string | null; delivered: boolean }>, [EmailMessage]>;
  const saved: Record<string, string | undefined> = {};
  const ENV = {
    EMAIL_UNSUBSCRIBE_URL_BASE: 'https://api-rehearsal.example.test',
    EMAIL_FROM_ADDRESS: 'no-reply@arestrainingclub.com',
    EMAIL_CAMPAIGN_SENDERS: JSON.stringify({
      'ares-fitness': {
        fromName: 'ARES Training Club',
        fromAddress: 'fernando@arestrainingclub.com',
        replyTo: 'fernando@arestrainingclub.com',
      },
    }),
  };
  const PASS = 'password12';

  beforeAll(async () => {
    for (const key of [...Object.keys(ENV), 'EMAIL_CAMPAIGN_WORKER']) saved[key] = process.env[key];
    Object.assign(process.env, ENV);
    delete process.env['EMAIL_CAMPAIGN_WORKER'];
    app = await createTestApp();
    prisma = app.get(PrismaService);
    communications = app.get(CommunicationsService);
    sendSpy = jest.spyOn(app.get<EmailProvider>(EMAIL_PROVIDER), 'send');
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    sendSpy.mockReset();
    sendSpy.mockImplementation(async (message) => ({ providerMessageId: `msg-${message.to}`, delivered: true }));
    delete process.env['EMAIL_CAMPAIGN_WORKER'];
  });

  afterAll(async () => {
    sendSpy.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
  });

  async function fixture() {
    const studio = await createStudio(prisma, { slug: 'ares-fitness', timezone: 'America/Mexico_City' });
    await prisma.studio.update({ where: { id: studio.id }, data: { appDisplayName: 'ARES', supportEmail: 'hola@arestrainingclub.com' } });
    const owner = await createUserWithPassword(prisma, { email: `owner-${Date.now()}@e2e.local`, password: PASS });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const member = await createUserWithPassword(prisma, { email: 'qa-member@e2e.local', password: PASS });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: owner.email, password: PASS }).expect(201);
    return { studio, member, token: (login.body as { accessToken: string }).accessToken, base: `/api/v1/studios/${studio.id}/communications` };
  }

  async function queueCampaign(f: Awaited<ReturnType<typeof fixture>>, key: string) {
    const audience = { includeUserIds: [f.member.id] };
    const preview = await request(app.getHttpServer()).post(`${f.base}/preview`).set('Authorization', `Bearer ${f.token}`).send(audience).expect(200);
    const created = await request(app.getHttpServer())
      .post(`${f.base}/campaigns`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ ...audience, subject: 'Horario de diciembre', bodyText: 'Hola, este es el horario.', idempotencyKey: key, previewFingerprint: preview.body.previewFingerprint })
      .expect(201);
    return created.body.id as string;
  }

  it('shows the campaign sender and active delivery, and sends with the ARES From and Reply-To', async () => {
    const f = await fixture();
    const status = await request(app.getHttpServer()).get(`${f.base}/status`).set('Authorization', `Bearer ${f.token}`).expect(200);
    expect(status.body).toMatchObject({
      delivery: { active: true, message: null },
      sender: { source: 'CAMPAIGN_SENDER', fromName: 'ARES Training Club', fromAddress: 'fernando@arestrainingclub.com', replyTo: 'fernando@arestrainingclub.com' },
      unsubscribeConfigured: true,
    });

    const id = await queueCampaign(f, 'sender-e2e-0001');
    await request(app.getHttpServer()).post(`${f.base}/campaigns/${id}/confirm`).set('Authorization', `Bearer ${f.token}`).send({ confirm: true }).expect(200);
    await communications.deliver(id);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const mail = sendSpy.mock.calls[0]![0];
    expect(mail.to).toBe('qa-member@e2e.local');
    expect(mail.from).toEqual({ email: 'fernando@arestrainingclub.com', name: 'ARES Training Club' });
    expect(mail.replyTo).toBe('fernando@arestrainingclub.com');
    expect(mail.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/api-rehearsal\.example\.test\/api\/v1\/email\/unsubscribe\?token=/);
    expect(mail.idempotencyKey).toMatch(/^campaign-recipient:/);
    const detail = await request(app.getHttpServer()).get(`${f.base}/campaigns/${id}`).set('Authorization', `Bearer ${f.token}`).expect(200);
    expect(detail.body).toMatchObject({ status: 'COMPLETED', sentCount: 1, pendingCount: 0, deliveryState: null });
    expect(detail.body.recipients[0]).toMatchObject({ status: 'SENT', providerMessageId: 'msg-qa-member@e2e.local' });
  });

  it('password recovery keeps the platform sender (campaign sender is campaign-only)', async () => {
    const f = await fixture();
    await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .set('X-Forwarded-For', '203.0.113.77')
      .send({ email: 'qa-member@e2e.local', studioSlug: 'ares-fitness' })
      .expect(200);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const mail = sendSpy.mock.calls[0]![0];
    expect(mail.from.email).toBe('no-reply@arestrainingclub.com');
    expect(mail.from.email).not.toContain('fernando');
    expect(mail.replyTo).toBe('hola@arestrainingclub.com');
    expect(f.studio.slug).toBe('ares-fitness');
  });

  it('paused delivery is reported, blocks confirmation and marks queued campaigns PAUSED', async () => {
    const f = await fixture();
    const id = await queueCampaign(f, 'sender-e2e-0002');
    await request(app.getHttpServer()).post(`${f.base}/campaigns/${id}/confirm`).set('Authorization', `Bearer ${f.token}`).send({ confirm: true }).expect(200);
    process.env['EMAIL_CAMPAIGN_WORKER'] = '0';
    const status = await request(app.getHttpServer()).get(`${f.base}/status`).set('Authorization', `Bearer ${f.token}`).expect(200);
    expect(status.body.delivery.active).toBe(false);
    expect(status.body.delivery.message).toContain('pausados');
    const list = await request(app.getHttpServer()).get(`${f.base}/campaigns`).set('Authorization', `Bearer ${f.token}`).expect(200);
    expect(list.body[0]).toMatchObject({ status: 'SENDING', deliveryState: 'PAUSED', pendingCount: 1 });
    const second = await queueCampaign(f, 'sender-e2e-0003');
    const refused = await request(app.getHttpServer()).post(`${f.base}/campaigns/${second}/confirm`).set('Authorization', `Bearer ${f.token}`).send({ confirm: true }).expect(409);
    expect(refused.body.message).toContain('pausados');
    expect((await prisma.emailCampaign.findUniqueOrThrow({ where: { id: second } })).status).toBe('DRAFT');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('a campaign left queued past the stale window never sends until explicitly resumed', async () => {
    const f = await fixture();
    const id = await queueCampaign(f, 'sender-e2e-0004');
    await request(app.getHttpServer()).post(`${f.base}/campaigns/${id}/confirm`).set('Authorization', `Bearer ${f.token}`).send({ confirm: true }).expect(200);
    await prisma.emailCampaign.update({ where: { id }, data: { startedAt: new Date(Date.now() - 7 * 60 * 60_000) } });

    const list = await request(app.getHttpServer()).get(`${f.base}/campaigns`).set('Authorization', `Bearer ${f.token}`).expect(200);
    expect(list.body[0]).toMatchObject({ status: 'SENDING', deliveryState: 'STALE', pendingCount: 1 });
    await communications.deliver(id);
    expect(sendSpy).not.toHaveBeenCalled();

    await request(app.getHttpServer()).post(`${f.base}/campaigns/${id}/retry`).set('Authorization', `Bearer ${f.token}`).send({ confirm: true }).expect(200);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'EMAIL_CAMPAIGN_RETRIED', entityId: id } });
    expect(audit.metadata).toMatchObject({ resumedStaleCampaign: true });
    await communications.deliver(id);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0]![0].from.email).toBe('fernando@arestrainingclub.com');
  });
});
