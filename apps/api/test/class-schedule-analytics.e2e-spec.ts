import type { INestApplication } from '@nestjs/common';
import { BookingStatus, ClassStatus, Role } from '@prisma/client';
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

describe('Class Schedule Analytics 1.2 (e2e)', () => {
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
    const { email: e, password } = await createUserWithPassword(prisma, {
      email,
      password: 'password12',
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: e } });
    await createMembership(prisma, user.id, studioId, role);
    return { token: await loginAccessToken(app, e, password), userId: user.id };
  }

  it('OWNER/ADMIN allowed; STAFF/MEMBER/FRONT_DESK forbidden', async () => {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const { token: owner } = await tokenForRole(Role.OWNER, studio.id, 'own-cs@e2e.local');
    const { token: admin } = await tokenForRole(Role.ADMIN, studio.id, 'adm-cs@e2e.local');
    const { token: staff } = await tokenForRole(Role.STAFF, studio.id, 'stf-cs@e2e.local');
    const { token: member } = await tokenForRole(Role.MEMBER, studio.id, 'mem-cs@e2e.local');
    const { token: fd } = await tokenForRole(Role.FRONT_DESK, studio.id, 'fd-cs@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/classes/summary`)
      .set('Authorization', `Bearer ${owner}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/classes/activity`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);

    for (const tok of [staff, member, fd]) {
      await request(app.getHttpServer())
        .get(`/api/v1/studios/${studio.id}/analytics/classes/summary`)
        .set('Authorization', `Bearer ${tok}`)
        .expect(403);
    }
  });

  it('uses startsAt local buckets, excludes cancelled/future/open-gym, and keeps empty vs active', async () => {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const { token, userId: ownerId } = await tokenForRole(
      Role.OWNER,
      studio.id,
      'own-cs2@e2e.local',
    );
    const member = await createUserWithPassword(prisma, {
      email: 'm-cs@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);

    const push = await createClassTemplate(prisma, studio.id, { name: 'Push' });
    const openGym = await createClassTemplate(prisma, studio.id, {
      name: 'Open Gym',
    });
    await prisma.classTemplate.update({
      where: { id: openGym.id },
      data: { isOpenGymSlot: true },
    });

    // Wed 2026-08-12 07:00 Mexico = 13:00 UTC
    const wed7 = new Date('2026-08-12T13:00:00.000Z');
    const wed7end = new Date('2026-08-12T14:00:00.000Z');
    // Wed 08:00 Mexico = 14:00 UTC
    const wed8 = new Date('2026-08-12T14:00:00.000Z');
    const wed8end = new Date('2026-08-12T15:00:00.000Z');
    // Future
    const future = new Date('2027-01-10T13:00:00.000Z');
    const futureEnd = new Date('2027-01-10T14:00:00.000Z');

    const scStrong = await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: push.id,
        startsAt: wed7,
        endsAt: wed7end,
        capacity: 25,
        status: ClassStatus.SCHEDULED,
      },
    });
    const scWeak = await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: push.id,
        startsAt: wed8,
        endsAt: wed8end,
        capacity: 25,
        status: ClassStatus.SCHEDULED,
      },
    });
    await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: push.id,
        startsAt: new Date('2026-08-05T13:00:00.000Z'),
        endsAt: new Date('2026-08-05T14:00:00.000Z'),
        capacity: 25,
        status: ClassStatus.CANCELLED,
      },
    });
    await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: push.id,
        startsAt: future,
        endsAt: futureEnd,
        capacity: 25,
        status: ClassStatus.SCHEDULED,
      },
    });
    await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: openGym.id,
        startsAt: new Date('2026-08-11T13:00:00.000Z'),
        endsAt: new Date('2026-08-11T14:00:00.000Z'),
        capacity: 25,
        status: ClassStatus.SCHEDULED,
      },
    });
    // Empty eligible session (no booking/attendance) — after first attendance so trusted floor includes it
    await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: push.id,
        startsAt: new Date('2026-08-13T13:00:00.000Z'),
        endsAt: new Date('2026-08-13T14:00:00.000Z'),
        capacity: 25,
        status: ClassStatus.SCHEDULED,
      },
    });

    // Strong session: booking + attendance
    await prisma.booking.create({
      data: {
        studioId: studio.id,
        scheduledClassId: scStrong.id,
        userId: member.id,
        status: BookingStatus.CONFIRMED,
      },
    });
    await prisma.attendance.create({
      data: {
        studioId: studio.id,
        scheduledClassId: scStrong.id,
        userId: member.id,
        method: 'MANUAL',
        checkedInAt: new Date('2026-08-12T13:05:00.000Z'),
        checkedInByUserId: ownerId,
      },
    });
    // Walk-in on strong (extra attendance without booking) — must not inflate show denom
    const walkIn = await createUserWithPassword(prisma, {
      email: 'walk-cs@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, walkIn.id, studio.id, Role.MEMBER);
    await prisma.attendance.create({
      data: {
        studioId: studio.id,
        scheduledClassId: scStrong.id,
        userId: walkIn.id,
        method: 'MANUAL',
        checkedInAt: new Date('2026-08-12T13:06:00.000Z'),
        checkedInByUserId: ownerId,
      },
    });

    // Weak: confirmed booking cancelled should not hurt show rate
    await prisma.booking.create({
      data: {
        studioId: studio.id,
        scheduledClassId: scWeak.id,
        userId: member.id,
        status: BookingStatus.CANCELLED,
        cancelledAt: new Date('2026-08-12T12:00:00.000Z'),
        cancelSource: 'MEMBER',
      },
    });

    const summary = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/classes/summary?period=last_90d`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(summary.body.kpis.scheduledSessions).toBeGreaterThanOrEqual(3);
    expect(summary.body.kpis.emptySessions).toBeGreaterThanOrEqual(1);
    expect(summary.body.kpis.activeSessions).toBeGreaterThanOrEqual(1);
    expect(summary.body.kpis.showRatePct).toBe(100);
    expect(summary.body.instructorAttributionSufficient).toBe(false);
    expect(summary.body.waitlistAnalyticsAvailable).toBe(false);

    const activity = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/classes/activity?period=last_90d`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(activity.body.heatmap.some((c: { scheduleTime: string }) => c.scheduleTime === '07:00')).toBe(
      true,
    );
    expect(activity.body.instructorNote).toContain('instructor');

    const templates = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/classes/templates?period=last_90d`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(templates.body.data.every((t: { className: string }) => t.className !== 'Open Gym')).toBe(
      true,
    );

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/classes/templates/${push.id}?period=last_90d`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(detail.body.className).toBe('Push');
    expect(detail.body.recentSessions.length).toBeGreaterThan(0);
  });

  it('isolates studios', async () => {
    const a = await createStudio(prisma, { timezone: 'America/Mexico_City', slug: 'a-cs' });
    const b = await createStudio(prisma, { timezone: 'America/Mexico_City', slug: 'b-cs' });
    const { token } = await tokenForRole(Role.OWNER, a.id, 'own-iso@e2e.local');
    await tokenForRole(Role.OWNER, b.id, 'own-iso-b@e2e.local');

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${a.id}/analytics/classes/summary`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.kpis.attendances).toBe(0);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${b.id}/analytics/classes/summary`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
