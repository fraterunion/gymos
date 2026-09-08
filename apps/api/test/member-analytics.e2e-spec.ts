import type { INestApplication } from '@nestjs/common';
import { ClassStatus, Role } from '@prisma/client';
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
import {
  getStudioLocalDateKey,
  getStudioLocalHHmm,
  studioLocalDateKeyToUtcAnchor,
} from '../src/common/date/studio-local-date';

/** Fixed UTC-6 year-round (Mexico abolished DST in 2022) — the local month starts
 *  6 hours AFTER the UTC month, which is the boundary these fixtures exercise. */
const TZ = 'America/Mexico_City';

/** UTC instant when the CURRENT studio-local month began (1st 00:00 local = 1st 06:00Z). */
function currentLocalMonthStartUtc(now: Date): Date {
  const monthKey = getStudioLocalDateKey(now, TZ).slice(0, 8);
  return studioLocalDateKeyToUtcAnchor(`${monthKey}01`, TZ);
}

/**
 * An instant provably inside the this_month window [local month start, now] at ANY
 * run date: the midpoint of the window. Valid even in the first second of the month
 * (midpoint degenerates to the boundary, which is inclusive on both ends).
 */
function instantInsideCurrentLocalMonth(now: Date): Date {
  const start = currentLocalMonthStartUtc(now);
  return new Date(Math.floor((start.getTime() + now.getTime()) / 2));
}

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

describe('Member Analytics (e2e)', () => {
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
    const { id: userId, email: e, password } = await createUserWithPassword(prisma, {
      email,
      password: 'password12',
    });
    await createMembership(prisma, userId, studioId, role);
    return loginAccessToken(app, e, password);
  }

  it('OWNER can read member analytics summary', async () => {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const token = await tokenForRole(Role.OWNER, studio.id, 'owner-ma@e2e.local');

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/members/summary?period=this_month`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.kpis).toBeDefined();
    expect(res.body.timezone).toBe('America/Mexico_City');
  });

  it('STAFF is forbidden from member analytics', async () => {
    const studio = await createStudio(prisma);
    const token = await tokenForRole(Role.STAFF, studio.id, 'staff-ma@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/members/summary`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('MEMBER role cannot access member analytics', async () => {
    const studio = await createStudio(prisma);
    const token = await tokenForRole(Role.MEMBER, studio.id, 'member-ma@e2e.local');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/members`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('counts member attendance in studio timezone month', async () => {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const ownerToken = await tokenForRole(Role.OWNER, studio.id, 'owner-ma2@e2e.local');
    const { id: memberId } = await createUserWithPassword(prisma, {
      email: 'member-att@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, memberId, studio.id, Role.MEMBER);

    const template = await createClassTemplate(prisma, studio.id, { name: 'Pull' });

    // In-window row: provably inside [studio-local month start, now] at any run date.
    const now = new Date();
    const inWindowCheckIn = instantInsideCurrentLocalMonth(now);
    const scheduled = await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: template.id,
        startsAt: new Date(inWindowCheckIn.getTime() - 5 * 60_000),
        endsAt: new Date(inWindowCheckIn.getTime() + 55 * 60_000),
        capacity: 12,
        status: ClassStatus.SCHEDULED,
      },
    });
    await prisma.attendance.create({
      data: {
        studioId: studio.id,
        scheduledClassId: scheduled.id,
        userId: memberId,
        checkedInAt: inWindowCheckIn,
        method: 'MANUAL',
      },
    });

    // Timezone discriminator: 30 min BEFORE the local month started = 23:30 on the
    // last day of the previous STUDIO-LOCAL month, but (CDMX = UTC-6) 05:30Z on the
    // 1st — i.e. inside the current UTC calendar month, and always in the past
    // (now is in the local month, so now >= local month start > this instant).
    // Correct studio-timezone months exclude it; a UTC-month regression would count
    // it and break the exact totals asserted below.
    const prevLocalMonthCheckIn = new Date(
      currentLocalMonthStartUtc(now).getTime() - 30 * 60_000,
    );
    const prevMonthClass = await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: template.id,
        startsAt: new Date(prevLocalMonthCheckIn.getTime() - 5 * 60_000),
        endsAt: new Date(prevLocalMonthCheckIn.getTime() + 55 * 60_000),
        capacity: 12,
        status: ClassStatus.SCHEDULED,
      },
    });
    await prisma.attendance.create({
      data: {
        studioId: studio.id,
        scheduledClassId: prevMonthClass.id,
        userId: memberId,
        checkedInAt: prevLocalMonthCheckIn,
        method: 'MANUAL',
      },
    });

    const summary = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/members/summary?period=this_month`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    // Exactly the in-window attendance: the previous-local-month row must NOT be
    // counted even though it falls in the current UTC month.
    expect(summary.body.kpis.attendances).toBe(1);
    expect(summary.body.kpis.membersAttended).toBe(1);
  });

  it('uses class startsAt for favorite schedule time, not check-in drift', async () => {
    const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
    const ownerToken = await tokenForRole(Role.OWNER, studio.id, 'owner-ma3@e2e.local');
    const { id: memberId } = await createUserWithPassword(prisma, {
      email: 'member-sched@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, memberId, studio.id, Role.MEMBER);
    const template = await createClassTemplate(prisma, studio.id, { name: 'Morning Pull' });

    // Window inclusion is driven by checkedInAt; the DISPLAYED time must come from the
    // class startsAt. Anchor the check-in provably inside [local month start, now], and
    // put the class at 13:00Z on the check-in's studio-local day = 07:00 CDMX (UTC-6).
    // The check-in instant is deliberately hours away from 07:00 local, so an
    // implementation deriving favoriteTime from check-in time (or formatting the class
    // time in UTC — 13:00) cannot produce the asserted '07:00'.
    let checkedInAt = instantInsideCurrentLocalMonth(new Date());
    if (getStudioLocalHHmm(checkedInAt, TZ) === '07:00') {
      // Vanishingly rare collision with the asserted value; +90s keeps the instant
      // inside the window (a 07:00-local midpoint implies >= 7h of window remains).
      checkedInAt = new Date(checkedInAt.getTime() + 90_000);
    }
    const startsAt = new Date(`${getStudioLocalDateKey(checkedInAt, TZ)}T13:00:00.000Z`);
    const scheduled = await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: template.id,
        startsAt, // 07:00 CDMX on the check-in's local day
        endsAt: new Date(startsAt.getTime() + 60 * 60_000),
        capacity: 12,
        status: ClassStatus.SCHEDULED,
      },
    });
    await prisma.attendance.create({
      data: {
        studioId: studio.id,
        scheduledClassId: scheduled.id,
        userId: memberId,
        checkedInAt,
        method: 'MANUAL',
      },
    });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/analytics/members/${memberId}?period=this_month`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(detail.body.favoriteTime).toBe('07:00');
    expect(detail.body.favoriteClass).toBe('Morning Pull');
  });
});
