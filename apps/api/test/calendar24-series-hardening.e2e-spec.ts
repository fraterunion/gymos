import type { INestApplication } from '@nestjs/common';
import { ClassStatus, Role } from '@prisma/client';
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
  addDaysToDateKey,
  getDayOfWeekFromDateKey,
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
} from '../src/common/date/studio-local-date';

describe('Calendar 2.4 series hardening (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seriesService: ScheduleSeriesService;
  let generatorService: ScheduleGeneratorService;

  const MX = 'America/Mexico_City';
  const NY = 'America/New_York';
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

  async function createWeeklySeries(
    studioId: string,
    classTemplateId: string,
    actorId: string,
    tz: string,
    startsOn = '2026-08-20',
    endsOn: string | null = null,
  ) {
    return seriesService.createRecurringSeries(
      studioId,
      {
        classTemplateId,
        daysOfWeek: [4],
        startTime: '07:15',
        intervalWeeks: 1,
        startsOn,
        endsOn,
        capacity: 12,
        confirmWarnings: true,
      },
      actorId,
    );
  }

  it('weekly → biweekly reconciles future cadence', async () => {
    const studio = await createStudio(prisma, { timezone: MX });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    await createWeeklySeries(studio.id, tpl.id, admin.id, MX);

    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    const anchor = await prisma.scheduledClass.findFirst({
      where: { scheduleTemplateId: template!.id, status: ClassStatus.SCHEDULED },
      orderBy: { startsAt: 'asc' },
    });

    const before = await prisma.scheduledClass.count({
      where: { scheduleTemplateId: template!.id, status: ClassStatus.SCHEDULED },
    });

    await seriesService.editOccurrence(
      studio.id,
      anchor!.id,
      { scope: 'SERIES', intervalWeeks: 2, confirmReservations: true },
      admin.id,
    );

    const afterTemplate = await prisma.scheduleTemplate.findUnique({ where: { id: template!.id } });
    expect(afterTemplate?.intervalWeeks).toBe(2);

    const cancelled = await prisma.scheduledClass.count({
      where: { scheduleTemplateId: template!.id, status: ClassStatus.CANCELLED },
    });
    expect(cancelled).toBeGreaterThan(0);
    expect(
      await prisma.scheduledClass.count({
        where: { scheduleTemplateId: template!.id, status: ClassStatus.SCHEDULED },
      }),
    ).toBeLessThanOrEqual(before);
  });

  it('unbounded → bounded cancels rows after inclusive end date', async () => {
    const studio = await createStudio(prisma, { timezone: MX });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    await createWeeklySeries(studio.id, tpl.id, admin.id, MX);

    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    const anchor = await prisma.scheduledClass.findFirst({
      where: { scheduleTemplateId: template!.id, status: ClassStatus.SCHEDULED },
      orderBy: { startsAt: 'asc' },
    });

    await seriesService.editOccurrence(
      studio.id,
      anchor!.id,
      { scope: 'SERIES', endsOn: '2026-09-30', confirmReservations: true },
      admin.id,
    );

    const afterEnd = await prisma.scheduledClass.findMany({
      where: {
        scheduleTemplateId: template!.id,
        status: ClassStatus.SCHEDULED,
        startsAt: { gt: studioLocalDateKeyToUtcAnchor('2026-09-30', MX) },
      },
    });
    expect(afterEnd).toHaveLength(0);
  });

  it('booked off-cadence occurrence requires confirmation', async () => {
    const studio = await createStudio(prisma, { timezone: MX });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    let startsOn = addDaysToDateKey(getStudioLocalDateKey(new Date(), MX), 21);
    while (getDayOfWeekFromDateKey(startsOn) !== 4) {
      startsOn = addDaysToDateKey(startsOn, 1);
    }
    await createWeeklySeries(studio.id, tpl.id, admin.id, MX, startsOn);

    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    const now = new Date();
    const futures = await prisma.scheduledClass.findMany({
      where: {
        scheduleTemplateId: template!.id,
        status: ClassStatus.SCHEDULED,
        startsAt: { gte: now },
      },
      orderBy: { startsAt: 'asc' },
      take: 3,
    });
    expect(futures.length).toBeGreaterThanOrEqual(2);
    const member = await createUserWithPassword(prisma, { email: `m-${Date.now()}@e2e.local` });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await createConfirmedBooking(prisma, studio.id, futures[1]!.id, member.id);

    await expect(
      seriesService.editOccurrence(
        studio.id,
        futures[0]!.id,
        { scope: 'SERIES', intervalWeeks: 2 },
        admin.id,
      ),
    ).rejects.toThrow(/confirmation|Reservation/i);
  });

  it('legacy startsAt remains NULL after recurrence edit', async () => {
    const studio = await createStudio(prisma, { timezone: MX });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');

    const legacy = await prisma.scheduleTemplate.create({
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
      studioLocalDateKeyToUtcAnchor('2026-08-20', MX),
      studioLocalDateKeyToUtcAnchor('2026-10-01', MX),
      { isDryRun: false, triggeredBy: 'MANUAL' },
    );

    const anchor = await prisma.scheduledClass.findFirst({
      where: { scheduleTemplateId: legacy.id, status: ClassStatus.SCHEDULED },
      orderBy: { startsAt: 'asc' },
    });

    await seriesService.editOccurrence(
      studio.id,
      anchor!.id,
      { scope: 'SERIES', intervalWeeks: 2, confirmReservations: true },
      admin.id,
    );

    const after = await prisma.scheduleTemplate.findUnique({ where: { id: legacy.id } });
    expect(after?.startsAt).toBeNull();
  });

  it('finish series at explicit boundary sets endsAt and cancels future rows', async () => {
    const studio = await createStudio(prisma, { timezone: MX });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    await createWeeklySeries(studio.id, tpl.id, admin.id, MX);
    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });

    const result = await seriesService.finishSeries(
      studio.id,
      template!.id,
      { mode: 'ON_DATE', boundaryDate: '2026-09-30', confirmReservations: true },
      admin.id,
    );

    expect(result.boundaryDateKey).toBe('2026-09-30');
    const updated = await prisma.scheduleTemplate.findUnique({ where: { id: template!.id } });
    expect(getStudioLocalDateKey(updated!.endsAt!, MX)).toBe('2026-09-30');

    const audit = await prisma.auditLog.findFirst({
      where: { studioId: studio.id, action: 'SCHEDULE_SERIES_FINISHED' },
    });
    expect(audit?.metadata).toMatchObject({ boundaryDateKey: '2026-09-30' });
  });

  it('generator after frequency change produces no duplicate canonical keys', async () => {
    const studio = await createStudio(prisma, { timezone: MX });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    await createWeeklySeries(studio.id, tpl.id, admin.id, MX);
    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    const anchor = await prisma.scheduledClass.findFirst({
      where: { scheduleTemplateId: template!.id, status: ClassStatus.SCHEDULED },
      orderBy: { startsAt: 'asc' },
    });

    await seriesService.editOccurrence(
      studio.id,
      anchor!.id,
      { scope: 'SERIES', intervalWeeks: 2, confirmReservations: true },
      admin.id,
    );

    await generatorService.generateRange(
      studio.id,
      studioLocalDateKeyToUtcAnchor('2026-08-01', MX),
      studioLocalDateKeyToUtcAnchor('2026-12-01', MX),
      { isDryRun: false, triggeredBy: 'MANUAL' },
    );

    const dup = await prisma.$queryRaw<{ cnt: number }[]>`
      SELECT COUNT(*)::int AS cnt FROM (
        SELECT class_template_id, starts_at FROM scheduled_classes
        WHERE studio_id = ${studio.id}
        GROUP BY class_template_id, starts_at HAVING COUNT(*) > 1
      ) d`;
    expect(Number(dup[0]?.cnt ?? 0)).toBe(0);
  });

  it('STAFF cannot edit series recurrence over HTTP', async () => {
    const studio = await createStudio(prisma, { timezone: MX });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    const staff = await seedUser(studio.id, Role.STAFF, 'staff');
    await createWeeklySeries(studio.id, tpl.id, admin.id, MX);
    const anchor = await prisma.scheduledClass.findFirst({
      where: { studioId: studio.id, status: ClassStatus.SCHEDULED },
    });
    const token = await loginToken(staff.email);

    await request(app.getHttpServer())
      .patch(`/api/v1/studios/${studio.id}/schedule-series/occurrences/${anchor!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ scope: 'SERIES', intervalWeeks: 2 })
      .expect(403);
  });

  it('preserves Mexico City local schedule time after edit', async () => {
    const studio = await createStudio(prisma, { timezone: MX });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    await createWeeklySeries(studio.id, tpl.id, admin.id, MX, '2026-08-20');
    const anchor = await prisma.scheduledClass.findFirst({
      where: { studioId: studio.id, status: ClassStatus.SCHEDULED },
      orderBy: { startsAt: 'asc' },
    });

    await seriesService.editOccurrence(
      studio.id,
      anchor!.id,
      {
        scope: 'SERIES',
        localStart: {
          date: getStudioLocalDateKey(anchor!.startsAt, MX),
          time: '08:00',
        },
        confirmReservations: true,
      },
      admin.id,
    );

    const updated = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    expect(updated?.startTime).toBe('08:00');
  });

  it('preserves New York DST anchor when editing bounded end', async () => {
    const studio = await createStudio(prisma, { timezone: NY });
    const tpl = await createClassTemplate(prisma, studio.id);
    const admin = await seedUser(studio.id, Role.ADMIN, 'admin');
    await createWeeklySeries(studio.id, tpl.id, admin.id, NY, '2026-11-01', '2026-11-30');
    const anchor = await prisma.scheduledClass.findFirst({
      where: { studioId: studio.id, status: ClassStatus.SCHEDULED },
      orderBy: { startsAt: 'asc' },
    });

    await seriesService.editOccurrence(
      studio.id,
      anchor!.id,
      { scope: 'SERIES', endsOn: '2026-11-15', confirmReservations: true },
      admin.id,
    );

    const updated = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    expect(getStudioLocalDateKey(updated!.endsAt!, NY)).toBe('2026-11-15');
  });
});
