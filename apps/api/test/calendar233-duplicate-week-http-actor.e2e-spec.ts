import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
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
import { studioLocalTimeToUtc } from '../src/common/date/studio-local-date';

describe('Calendar 2.3.3 duplicate-week HTTP actor (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const TZ = 'America/Mexico_City';
  const SOURCE_WEEK = '2026-08-17';
  const TARGET_WEEK = '2026-08-24';
  const ADMIN_PASS = 'password12';

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

  async function seedAdmin(studioId: string) {
    const admin = await createUserWithPassword(prisma, {
      email: `admin-http-${Date.now()}-${Math.random()}@e2e.local`,
      password: ADMIN_PASS,
    });
    await createMembership(prisma, admin.id, studioId, Role.ADMIN);
    return admin;
  }

  async function loginToken(email: string) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: ADMIN_PASS })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  it('HTTP duplicate-week execute writes audit with JWT sub as actor', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc('2026-08-18', '07:00', TZ),
      endsAt: studioLocalTimeToUtc('2026-08-18', '08:00', TZ),
    });
    const admin = await seedAdmin(studio.id);
    const token = await loginToken(admin.email);
    const idempotencyKey = `http-actor-${Date.now()}`;

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/schedule-operations/duplicate-week`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: [TARGET_WEEK],
        confirmWarnings: true,
        idempotencyKey,
      })
      .expect(200);

    const body = res.body as {
      createdCount: number;
      reusedCount: number;
      affectedClassIds: string[];
    };
    expect(body.createdCount).toBe(1);
    expect(body.reusedCount).toBe(0);
    expect(body.affectedClassIds.length).toBeGreaterThan(0);

    const audit = await prisma.auditLog.findFirst({
      where: { studioId: studio.id, action: 'SCHEDULE_WEEK_DUPLICATED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.actorUserId).toBe(admin.id);
    expect(audit?.actorUserId).not.toBe('unknown');

    const meta = audit?.metadata as Record<string, unknown> | null;
    expect(meta?.idempotencyKey).toBe(idempotencyKey);
    expect(meta?.result).toBeTruthy();
    expect((meta?.result as Record<string, unknown>)?.reconciliationItems).toBeUndefined();
  });

  it('returns JSON-safe duplicate-week result over HTTP', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc('2026-08-18', '07:00', TZ),
      endsAt: studioLocalTimeToUtc('2026-08-18', '08:00', TZ),
    });
    const admin = await seedAdmin(studio.id);
    const token = await loginToken(admin.email);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/schedule-operations/duplicate-week`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: [TARGET_WEEK],
        confirmWarnings: true,
      })
      .expect(200);

    expect(() => JSON.stringify(res.body)).not.toThrow();
    expect(typeof res.body.createdCount).toBe('number');
    expect(Array.isArray(res.body.affectedClassIds)).toBe(true);
  });
});
