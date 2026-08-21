import type { INestApplication } from '@nestjs/common';
import {
  BookingStatus,
  ClassStatus,
  Role,
  ScheduleOccurrenceExceptionKind,
} from '@prisma/client';
import { ScheduleGeneratorService } from '../src/schedule-generator/schedule-generator.service';
import { ScheduleSeriesService } from '../src/schedule/schedule-series.service';
import { ScheduleService } from '../src/schedule/schedule.service';
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

describe('Calendar 2.1 series invariants (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seriesService: ScheduleSeriesService;
  let generatorService: ScheduleGeneratorService;
  let scheduleService: ScheduleService;

  const TZ = 'America/Mexico_City';

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    seriesService = app.get(ScheduleSeriesService);
    generatorService = app.get(ScheduleGeneratorService);
    scheduleService = app.get(ScheduleService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedAdmin(studioId: string) {
    const admin = await createUserWithPassword(prisma, { email: `admin-${Date.now()}@e2e.local` });
    await createMembership(prisma, admin.id, studioId, Role.ADMIN);
    return admin;
  }

  const SERIES_START = '2026-08-26';
  const SERIES_END = '2026-11-18';
  const SPLIT_DATE = '2026-09-16';
  const PREDECESSOR_END = '2026-09-09';
  const BOOKING_DATE = '2026-09-23';

  async function createWednesdaySeries(studioId: string, classTemplateId: string) {
    const admin = await seedAdmin(studioId);
    return seriesService.createRecurringSeries(
      studioId,
      {
        classTemplateId,
        daysOfWeek: [3],
        startTime: '07:00',
        intervalWeeks: 1,
        startsOn: SERIES_START,
        endsOn: SERIES_END,
        capacity: 25,
        confirmWarnings: true,
      },
      admin.id,
    );
  }

  it('DETACHED survives entire-series configuration edit', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id, { name: 'Full Body' });
    await createWednesdaySeries(studio.id, tpl.id);

    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    expect(template).toBeTruthy();

    const sep17 = await prisma.scheduledClass.findFirst({
      where: {
        studioId: studio.id,
        scheduleTemplateId: template!.id,
        startsAt: studioLocalTimeToUtc(SPLIT_DATE, '07:00', TZ),
      },
    });
    expect(sep17).toBeTruthy();

    const admin = await seedAdmin(studio.id);
    await seriesService.editOccurrence(
      studio.id,
      sep17!.id,
      {
        scope: 'SINGLE',
        localStart: { date: '2026-09-16', time: '08:00' },
        localEnd: { date: '2026-09-16', time: '09:00' },
      },
      admin.id,
    );

    const detached = await prisma.scheduledClass.findUnique({ where: { id: sep17!.id } });
    expect(detached?.exceptionKind).toBe(ScheduleOccurrenceExceptionKind.DETACHED);
    expect(detached?.startsAt).toEqual(studioLocalTimeToUtc('2026-09-16', '08:00', TZ));

    await seriesService.editOccurrence(
      studio.id,
      sep17!.id,
      { scope: 'SERIES', capacity: 30 },
      admin.id,
    );

    const afterSeriesEdit = await prisma.scheduledClass.findUnique({ where: { id: sep17!.id } });
    expect(afterSeriesEdit?.startsAt).toEqual(studioLocalTimeToUtc('2026-09-16', '08:00', TZ));
    expect(afterSeriesEdit?.capacity).toBe(25);
    expect(afterSeriesEdit?.exceptionKind).toBe(ScheduleOccurrenceExceptionKind.DETACHED);
  });

  it('single detached edit blocks original slot regeneration on generator rerun', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await createWednesdaySeries(studio.id, tpl.id);

    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    const sep17 = await prisma.scheduledClass.findFirst({
      where: {
        scheduleTemplateId: template!.id,
        startsAt: studioLocalTimeToUtc(SPLIT_DATE, '07:00', TZ),
      },
    });
    const admin = await seedAdmin(studio.id);
    await seriesService.editOccurrence(
      studio.id,
      sep17!.id,
      {
        scope: 'SINGLE',
        localStart: { date: '2026-09-16', time: '08:00' },
        localEnd: { date: '2026-09-16', time: '09:00' },
      },
      admin.id,
    );

    const beforeCount = await prisma.scheduledClass.count({
      where: { studioId: studio.id, scheduleTemplateId: template!.id },
    });

    await generatorService.generateRange(
      studio.id,
      studioLocalDateKeyToUtcAnchor('2026-08-01', TZ),
      studioLocalDateKeyToUtcAnchor('2026-12-01', TZ),
      { isDryRun: false, triggeredBy: 'MANUAL' },
    );

    const sep17Rows = await prisma.scheduledClass.findMany({
      where: {
        studioId: studio.id,
        scheduleTemplateId: template!.id,
        startsAt: {
          gte: studioLocalDateKeyToUtcAnchor('2026-09-16', TZ),
          lt: studioLocalDateKeyToUtcAnchor('2026-09-17', TZ),
        },
      },
    });
    expect(sep17Rows).toHaveLength(1);
    expect(sep17Rows[0]!.startsAt).toEqual(studioLocalTimeToUtc('2026-09-16', '08:00', TZ));

    const sep24 = await prisma.scheduledClass.findFirst({
      where: { startsAt: studioLocalTimeToUtc(BOOKING_DATE, '07:00', TZ) },
    });
    expect(sep24?.startsAt).toEqual(studioLocalTimeToUtc('2026-09-23', '07:00', TZ));

    const afterCount = await prisma.scheduledClass.count({
      where: { studioId: studio.id, scheduleTemplateId: template!.id },
    });
    expect(afterCount).toBe(beforeCount);
  });

  it('single cancellation blocks regeneration for that template date', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await createWednesdaySeries(studio.id, tpl.id);

    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    const sep17 = await prisma.scheduledClass.findFirst({
      where: { startsAt: studioLocalTimeToUtc('2026-09-16', '07:00', TZ) },
    });
    const admin = await seedAdmin(studio.id);
    await seriesService.cancelOccurrence(
      studio.id,
      sep17!.id,
      'SINGLE',
      admin.id,
      'Holiday',
      false,
    );

    await generatorService.generateRange(
      studio.id,
      studioLocalDateKeyToUtcAnchor('2026-09-01', TZ),
      studioLocalDateKeyToUtcAnchor('2026-10-01', TZ),
      { isDryRun: false, triggeredBy: 'MANUAL' },
    );

    const rows = await prisma.scheduledClass.findMany({
      where: {
        scheduleTemplateId: template!.id,
        startsAt: studioLocalTimeToUtc(SPLIT_DATE, '07:00', TZ),
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(ClassStatus.CANCELLED);
  });

  it('FOLLOWING split relinks future rows to successor template', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await createWednesdaySeries(studio.id, tpl.id);

    const templateA = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    const sep17 = await prisma.scheduledClass.findFirst({
      where: { startsAt: studioLocalTimeToUtc('2026-09-16', '07:00', TZ) },
    });
    const admin = await seedAdmin(studio.id);

    const split = await seriesService.editOccurrence(
      studio.id,
      sep17!.id,
      {
        scope: 'FOLLOWING',
        localStart: { date: '2026-09-16', time: '08:00' },
        localEnd: { date: '2026-09-16', time: '09:00' },
      },
      admin.id,
    );

    const templateB = await prisma.scheduleTemplate.findUnique({
      where: { id: split.newTemplateId },
    });
    const templateAAfter = await prisma.scheduleTemplate.findUnique({
      where: { id: templateA!.id },
    });
    expect(templateB).toBeTruthy();
    expect(getStudioLocalDateKey(templateAAfter!.endsAt!, TZ)).toBe(PREDECESSOR_END);

    const futureRows = await prisma.scheduledClass.findMany({
      where: {
        studioId: studio.id,
        startsAt: { gte: studioLocalTimeToUtc('2026-09-16', '07:00', TZ) },
        status: ClassStatus.SCHEDULED,
      },
    });
    expect(futureRows.every((r) => r.scheduleTemplateId === templateB!.id)).toBe(true);
    expect(futureRows.every((r) => r.startsAt >= studioLocalTimeToUtc('2026-09-16', '08:00', TZ))).toBe(
      true,
    );
  });

  it('generator after split creates no duplicates and respects predecessor bounds', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await createWednesdaySeries(studio.id, tpl.id);

    const templateA = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    const sep17 = await prisma.scheduledClass.findFirst({
      where: { startsAt: studioLocalTimeToUtc('2026-09-16', '07:00', TZ) },
    });
    const admin = await seedAdmin(studio.id);
    const split = await seriesService.editOccurrence(
      studio.id,
      sep17!.id,
      { scope: 'FOLLOWING', localStart: { date: '2026-09-16', time: '08:00' } },
      admin.id,
    );

    await generatorService.generateRange(
      studio.id,
      studioLocalDateKeyToUtcAnchor('2026-08-01', TZ),
      studioLocalDateKeyToUtcAnchor('2026-12-01', TZ),
      { isDryRun: false, triggeredBy: 'MANUAL' },
    );

    const scheduled = await prisma.scheduledClass.findMany({
      where: { studioId: studio.id, status: ClassStatus.SCHEDULED },
      select: { classTemplateId: true, startsAt: true },
    });
    const keys = new Set<string>();
    for (const row of scheduled) {
      const key = `${row.classTemplateId}|${row.startsAt.toISOString()}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }

    const beyondSplitOnA = await prisma.scheduledClass.findFirst({
      where: {
        scheduleTemplateId: templateA!.id,
        startsAt: { gte: studioLocalTimeToUtc('2026-09-16', '07:00', TZ) },
        status: ClassStatus.SCHEDULED,
      },
    });
    expect(beyondSplitOnA).toBeNull();

    const onB = await prisma.scheduledClass.count({
      where: { scheduleTemplateId: split.newTemplateId, status: ClassStatus.SCHEDULED },
    });
    expect(onB).toBeGreaterThan(0);
  });

  it('FOLLOWING cancellation ends template without successor and blocks regeneration', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await createWednesdaySeries(studio.id, tpl.id);

    const template = await prisma.scheduleTemplate.findFirst({ where: { studioId: studio.id } });
    const sep17 = await prisma.scheduledClass.findFirst({
      where: { startsAt: studioLocalTimeToUtc('2026-09-16', '07:00', TZ) },
    });
    const admin = await seedAdmin(studio.id);

    await seriesService.cancelOccurrence(
      studio.id,
      sep17!.id,
      'FOLLOWING',
      admin.id,
      'Program ended',
      false,
    );

    const successors = await prisma.scheduleTemplate.count({
      where: { studioId: studio.id, id: { not: template!.id } },
    });
    expect(successors).toBe(0);

    const updated = await prisma.scheduleTemplate.findUnique({ where: { id: template!.id } });
    expect(getStudioLocalDateKey(updated!.endsAt!, TZ)).toBe(PREDECESSOR_END);

    await generatorService.generateRange(
      studio.id,
      studioLocalDateKeyToUtcAnchor('2026-09-01', TZ),
      studioLocalDateKeyToUtcAnchor('2026-12-01', TZ),
      { isDryRun: false, triggeredBy: 'MANUAL' },
    );

    const futureScheduled = await prisma.scheduledClass.count({
      where: {
        scheduleTemplateId: template!.id,
        startsAt: { gte: studioLocalTimeToUtc('2026-09-16', '07:00', TZ) },
        status: ClassStatus.SCHEDULED,
      },
    });
    expect(futureScheduled).toBe(0);
  });

  it('legacy ScheduleTemplate with NULL startsAt still generates historical dates', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const ct = await createClassTemplate(prisma, studio.id);
    await prisma.scheduleTemplate.create({
      data: {
        studioId: studio.id,
        classTemplateId: ct.id,
        dayOfWeek: 3,
        startTime: '07:00',
        active: true,
        startsAt: null,
        intervalWeeks: 1,
      },
    });

    const result = await generatorService.preview(
      studio.id,
      studioLocalDateKeyToUtcAnchor('2026-08-01', TZ),
      studioLocalDateKeyToUtcAnchor('2026-08-15', TZ),
    );
    expect(result.generated).toBeGreaterThan(0);
  });

  it('duplicate guard is class-template-specific', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const ct1 = await createClassTemplate(prisma, studio.id, { name: 'A' });
    const ct2 = await createClassTemplate(prisma, studio.id, { name: 'B' });
    const startsAt = studioLocalTimeToUtc('2026-09-16', '07:00', TZ);
    const endsAt = studioLocalTimeToUtc('2026-09-16', '08:00', TZ);

    await scheduleService.createScheduledClass(studio.id, {
      templateId: ct1.id,
      localStart: { date: '2026-09-16', time: '07:00' },
      localEnd: { date: '2026-09-16', time: '08:00' },
    });

    await expect(
      scheduleService.createScheduledClass(studio.id, {
        templateId: ct1.id,
        localStart: { date: '2026-09-16', time: '07:00' },
        localEnd: { date: '2026-09-16', time: '08:00' },
      }),
    ).rejects.toThrow();

    const other = await scheduleService.createScheduledClass(studio.id, {
      templateId: ct2.id,
      localStart: { date: '2026-09-16', time: '07:00' },
      localEnd: { date: '2026-09-16', time: '08:00' },
    });
    expect(other.startsAt).toEqual(startsAt);
    expect(other.endsAt).toEqual(endsAt);
  });

  it('booking survives FOLLOWING reconciliation with same occurrence ID', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const ct = await createClassTemplate(prisma, studio.id);
    await createWednesdaySeries(studio.id, ct.id);

    const sep24 = await prisma.scheduledClass.findFirst({
      where: { startsAt: studioLocalTimeToUtc(BOOKING_DATE, '07:00', TZ) },
    });
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const booking = await createConfirmedBooking(prisma, studio.id, sep24!.id, member.id);

    const admin = await seedAdmin(studio.id);
    await seriesService.editOccurrence(
      studio.id,
      sep24!.id,
      {
        scope: 'FOLLOWING',
        instructorId: null,
        localStart: { date: BOOKING_DATE, time: '08:00' },
        confirmReservations: true,
      },
      admin.id,
    );

    const updated = await prisma.scheduledClass.findUnique({
      where: { id: sep24!.id },
      include: { _count: { select: { bookings: { where: { status: BookingStatus.CONFIRMED } } } } },
    });
    expect(updated?.id).toBe(sep24!.id);
    expect(updated?.startsAt).toEqual(studioLocalTimeToUtc(BOOKING_DATE, '08:00', TZ));
    expect(updated?.scheduleTemplateId).not.toBe(sep24!.scheduleTemplateId);

    const bookingAfter = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(bookingAfter?.scheduledClassId).toBe(sep24!.id);
    expect(updated?._count.bookings).toBe(1);
  });

  it('split audit contains old/new template IDs and boundary', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const ct = await createClassTemplate(prisma, studio.id);
    await createWednesdaySeries(studio.id, ct.id);
    const sep17 = await prisma.scheduledClass.findFirst({
      where: { startsAt: studioLocalTimeToUtc('2026-09-16', '07:00', TZ) },
    });
    const admin = await seedAdmin(studio.id);

    await seriesService.editOccurrence(
      studio.id,
      sep17!.id,
      { scope: 'FOLLOWING', localStart: { date: '2026-09-16', time: '08:00' } },
      admin.id,
    );

    const audit = await prisma.auditLog.findFirst({
      where: { studioId: studio.id, action: 'SCHEDULE_SERIES_SPLIT' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
    const meta = audit!.metadata as Record<string, unknown>;
    expect(meta.scope).toBe('FOLLOWING');
    expect(meta.previousTemplateId).toBeTruthy();
    expect(meta.newTemplateId).toBeTruthy();
    expect(meta.boundaryDateKey).toBe(SPLIT_DATE);
    expect(meta.affectedClassCount).toBeGreaterThanOrEqual(0);
  });
});
