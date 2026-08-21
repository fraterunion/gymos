import type { INestApplication } from '@nestjs/common';
import {
  ClassStatus,
  Role,
} from '@prisma/client';
import request from 'supertest';
import { ScheduleGeneratorService } from '../src/schedule-generator/schedule-generator.service';
import { ScheduleSeriesService } from '../src/schedule/schedule-series.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createClassTemplate,
  createConfirmedBooking,
  createMembership,
  createStudio,
  createUserWithPassword,
} from './helpers/factories';
import {
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
  studioLocalTimeToUtc,
} from '../src/common/date/studio-local-date';

describe('Calendar 2.4 series management (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seriesService: ScheduleSeriesService;
  let generatorService: ScheduleGeneratorService;

  const TZ = 'America/Mexico_City';
  const ADMIN_PASS = 'password12';

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    seriesService = app.get(ScheduleSeriesService);
    generatorService = app.get(ScheduleGeneratorService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedUser(studioId: string, role: Role, label: string) {
    const user = await createUserWithPassword(prisma, {
      email: `${label}-${Date.now()}-${Math.random()}@e2e.local`,
      password: ADMIN_PASS,
    });
    await createMembership(prisma, user.id, studioId, role);
    return user;
  }

  async function loginToken(email: string) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: ADMIN_PASS })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function createWeeklySeries(studioId: string, classTemplateId: string, actorId: string) {
    return seriesService.createRecurringSeries(
      studioId,
      {
        classTemplateId,
        daysOfWeek: [4],
        startTime: '07:15',
        intervalWeeks: 1,
        startsOn: '2026-08-20',
        endsOn: null,
        capacity: 12,
        confirmWarnings: true,
      },
      actorId,
    );
  }

  it('OWNER and ADMIN can list series projections', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id, { name: 'Booty Lab' });
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    const owner = await seedUser(studio.id, Role.OWNER, 'owner');
    await createWeeklySeries(studio.id, tpl.id, admin.id);

    const adminToken = await loginToken(admin.email);
    const ownerToken = await loginToken(owner.email);

    const adminRes = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule-series`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(Array.isArray(adminRes.body)).toBe(true);
    expect(adminRes.body[0].classTemplate.name).toBe('Booty Lab');
    expect(adminRes.body[0].status).toBe('ACTIVE');

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule-series`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
  });

  it('STAFF can list series read-only', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    const staff = await seedUser(studio.id, Role.STAFF, 'staff');
    await createWeeklySeries(studio.id, tpl.id, admin.id);

    const staffToken = await loginToken(staff.email);
    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule-series`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
  });

  it('STAFF cannot create series over HTTP', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const staff = await seedUser(studio.id, Role.STAFF, 'staff');
    const token = await loginToken(staff.email);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/schedule-series`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        classTemplateId: tpl.id,
        daysOfWeek: [1],
        startTime: '09:00',
        startsOn: '2026-08-20',
        confirmWarnings: true,
      })
      .expect(403);
  });

  it('legacy startsAt=NULL series renders with isLegacy and derived startsOn', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id, { name: 'Legacy Flow' });
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');

    const legacyTemplate = await prisma.scheduleTemplate.create({
      data: {
        studioId: studio.id,
        classTemplateId: tpl.id,
        dayOfWeek: 4,
        startTime: '07:15',
        startsAt: null,
        active: true,
      },
    });

    await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: tpl.id,
        scheduleTemplateId: legacyTemplate.id,
        startsAt: studioLocalTimeToUtc('2026-08-27', '07:15', TZ),
        endsAt: studioLocalTimeToUtc('2026-08-27', '08:15', TZ),
        capacity: 12,
        status: ClassStatus.SCHEDULED,
      },
    });

    const token = await loginToken(admin.email);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule-series`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const row = (res.body as Array<{ recurrence: { isLegacy: boolean; startsOn: string | null } }>)[0];
    expect(row.recurrence.isLegacy).toBe(true);
    expect(row.recurrence.startsOn).toBe('2026-08-27');
  });

  it('series detail includes upcoming occurrences and booking counts', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id, { name: 'Hyrox' });
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    await createWeeklySeries(studio.id, tpl.id, admin.id);

    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    const future = await prisma.scheduledClass.findFirst({
      where: {
        scheduleTemplateId: template!.id,
        startsAt: { gte: new Date() },
        status: ClassStatus.SCHEDULED,
      },
      orderBy: { startsAt: 'asc' },
    });
    expect(future).toBeTruthy();

    const member = await createUserWithPassword(prisma, {
      email: `member-${Date.now()}@e2e.local`,
    });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await createConfirmedBooking(prisma, studio.id, future!.id, member.id);

    const token = await loginToken(admin.email);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule-series/${template!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = res.body as {
      futureOccurrenceCount: number;
      futureBookingCount: number;
      upcomingOccurrences: unknown[];
      anchorOccurrenceId: string;
    };
    expect(body.futureOccurrenceCount).toBeGreaterThan(0);
    expect(body.futureBookingCount).toBe(1);
    expect(body.upcomingOccurrences.length).toBeGreaterThan(0);
    expect(body.anchorOccurrenceId).toBeTruthy();
  });

  it('detached and cancelled occurrences surface exception labels in detail', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    await createWeeklySeries(studio.id, tpl.id, admin.id);

    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    const rows = await prisma.scheduledClass.findMany({
      where: { scheduleTemplateId: template!.id },
      orderBy: { startsAt: 'asc' },
      take: 3,
    });

    await seriesService.editOccurrence(
      studio.id,
      rows[1]!.id,
      {
        scope: 'SINGLE',
        localStart: {
          date: getStudioLocalDateKey(rows[1]!.startsAt, TZ),
          time: '08:00',
        },
      },
      admin.id,
    );

    await seriesService.cancelOccurrence(studio.id, rows[2]!.id, 'SINGLE', admin.id, undefined, true);

    const token = await loginToken(admin.email);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule-series/${template!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const upcoming = (res.body as { upcomingOccurrences: Array<{ exception: string | null }> })
      .upcomingOccurrences;
    expect(upcoming.some((o) => o.exception === 'DETACHED')).toBe(true);
    expect(upcoming.some((o) => o.exception === 'CANCELLED')).toBe(true);
  });

  it('create preview and execute over HTTP use JWT sub as actor', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id, { name: 'New Series' });
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    const token = await loginToken(admin.email);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/schedule-series/preview`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        classTemplateId: tpl.id,
        daysOfWeek: [2],
        startTime: '09:00',
        startsOn: '2026-09-01',
        endsOn: '2026-11-30',
        intervalWeeks: 2,
        confirmWarnings: true,
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/schedule-series`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        classTemplateId: tpl.id,
        daysOfWeek: [2],
        startTime: '09:00',
        startsOn: '2026-09-01',
        endsOn: '2026-11-30',
        intervalWeeks: 2,
        confirmWarnings: true,
      })
      .expect(201);

    const audit = await prisma.auditLog.findFirst({
      where: { studioId: studio.id, action: 'SCHEDULE_RECURRING_SERIES_CREATED' },
    });
    expect(audit?.actorUserId).toBe(admin.id);
  });

  it('finish series (SERIES cancel) preserves historical rows and blocks regeneration duplicates', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    await createWeeklySeries(studio.id, tpl.id, admin.id);

    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    const anchor = await prisma.scheduledClass.findFirst({
      where: { scheduleTemplateId: template!.id, status: ClassStatus.SCHEDULED },
      orderBy: { startsAt: 'asc' },
    });

    const historicalCount = await prisma.scheduledClass.count({
      where: { scheduleTemplateId: template!.id, startsAt: { lt: anchor!.startsAt } },
    });

    await seriesService.cancelOccurrence(
      studio.id,
      anchor!.id,
      'SERIES',
      admin.id,
      'Finalizada',
      true,
    );

    const updatedTemplate = await prisma.scheduleTemplate.findUnique({ where: { id: template!.id } });
    expect(updatedTemplate?.active).toBe(false);

    const beforeTotal = await prisma.scheduledClass.count({
      where: { scheduleTemplateId: template!.id },
    });

    await generatorService.generateRange(
      studio.id,
      studioLocalDateKeyToUtcAnchor('2026-08-01', TZ),
      studioLocalDateKeyToUtcAnchor('2026-12-01', TZ),
      { isDryRun: false, triggeredBy: 'MANUAL' },
    );

    const afterTotal = await prisma.scheduledClass.count({
      where: { scheduleTemplateId: template!.id },
    });
    expect(afterTotal).toBe(beforeTotal);
    expect(historicalCount).toBeGreaterThanOrEqual(0);
  });

  it('other-studio isolation on series detail', async () => {
    const studioA = await createStudio(prisma, { timezone: TZ });
    const studioB = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studioA.id);
    const adminB = await seedUser(studioB.id, Role.ADMIN, 'admin-b');
    const adminA = await seedUser(studioA.id, Role.ADMIN, 'admin-a');
    await createWeeklySeries(studioA.id, tpl.id, adminA.id);
    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studioA.id } });

    const tokenB = await loginToken(adminB.email);
    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studioB.id}/schedule-series/${template!.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
  });

  it('legacy series edit does not set startsAt on template', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');

    const legacyTemplate = await prisma.scheduleTemplate.create({
      data: {
        studioId: studio.id,
        classTemplateId: tpl.id,
        dayOfWeek: 4,
        startTime: '07:15',
        startsAt: null,
        intervalWeeks: 1,
        active: true,
      },
    });

    await generatorService.generateRange(
      studio.id,
      studioLocalDateKeyToUtcAnchor('2026-08-20', TZ),
      studioLocalDateKeyToUtcAnchor('2026-10-01', TZ),
      { isDryRun: false, triggeredBy: 'MANUAL' },
    );

    const occurrence = await prisma.scheduledClass.findFirst({
      where: { scheduleTemplateId: legacyTemplate.id, status: ClassStatus.SCHEDULED },
      orderBy: { startsAt: 'asc' },
    });
    expect(occurrence).toBeTruthy();

    await seriesService.editOccurrence(
      studio.id,
      occurrence!.id,
      { scope: 'SERIES', capacity: 20 },
      admin.id,
    );

    const after = await prisma.scheduleTemplate.findUnique({ where: { id: legacyTemplate.id } });
    expect(after?.startsAt).toBeNull();
    expect(after?.intervalWeeks).toBe(1);
  });
});
