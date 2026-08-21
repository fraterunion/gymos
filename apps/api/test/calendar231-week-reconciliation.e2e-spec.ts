import type { INestApplication } from '@nestjs/common';
import {
  ClassStatus,
  Role,
  ScheduleOccurrenceExceptionKind,
} from '@prisma/client';
import { ScheduleGeneratorService } from '../src/schedule-generator/schedule-generator.service';
import { ScheduleOperationsService } from '../src/schedule/schedule-operations.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createClassTemplate,
  createConfirmedBooking,
  createMembership,
  createScheduledClass,
  createStudio,
  createUserWithPassword,
} from './helpers/factories';
import {
  studioLocalDateKeyToUtcAnchor,
  studioLocalTimeToUtc,
} from '../src/common/date/studio-local-date';

describe('Calendar 2.3.1 duplicate-week reconciliation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ops: ScheduleOperationsService;
  let generatorService: ScheduleGeneratorService;

  const TZ = 'America/Mexico_City';
  const SOURCE_WEEK = '2026-08-17';
  const TARGET_WEEK = '2026-08-24';

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ops = app.get(ScheduleOperationsService);
    generatorService = app.get(ScheduleGeneratorService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedAdmin(studioId: string) {
    const admin = await createUserWithPassword(prisma, {
      email: `admin-${Date.now()}-${Math.random()}@e2e.local`,
      password: 'password12',
    });
    await createMembership(prisma, admin.id, studioId, Role.ADMIN);
    return admin;
  }

  async function seedSourceWeekClass(
    studioId: string,
    templateId: string,
    localDate: string,
    time = '07:00',
    overrides: Parameters<typeof createScheduledClass>[3] = {},
  ) {
    return createScheduledClass(prisma, studioId, templateId, {
      startsAt: studioLocalTimeToUtc(localDate, time, TZ),
      endsAt: studioLocalTimeToUtc(localDate, '08:00', TZ),
      capacity: 12,
      ...overrides,
    });
  }

  it('copies empty target week exactly from source', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18');
    const admin = await seedAdmin(studio.id);

    const result = await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: [TARGET_WEEK],
        confirmWarnings: true,
      },
      admin.id,
    );

    expect(result.createdCount).toBe(1);
    const copy = await prisma.scheduledClass.findFirst({
      where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
    });
    expect(copy?.scheduleTemplateId).toBeNull();
  });

  it('reuses identical target week without creating duplicates', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18');
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25');
    const admin = await seedAdmin(studio.id);

    const result = await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: [TARGET_WEEK],
        confirmWarnings: true,
      },
      admin.id,
    );

    expect(result.reusedCount).toBe(1);
    expect(result.createdCount).toBe(0);
    const atSlot = await prisma.scheduledClass.findMany({
      where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
    });
    expect(atSlot).toHaveLength(1);
  });

  it('creates missing classes in partially populated target week', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00');
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-19', '07:00');
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25', '07:00');
    const admin = await seedAdmin(studio.id);

    const result = await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: [TARGET_WEEK],
        confirmWarnings: true,
      },
      admin.id,
    );

    expect(result.reusedCount).toBe(1);
    expect(result.createdCount).toBe(1);
  });

  it('removes empty extra target class not in source week', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00');
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25', '08:00');
    const admin = await seedAdmin(studio.id);

    const result = await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: [TARGET_WEEK],
        confirmWarnings: true,
        confirmRemovals: true,
      },
      admin.id,
    );

    expect(result.removedCount).toBe(1);
    expect(result.createdCount).toBe(1);
    const extra = await prisma.scheduledClass.findFirst({
      where: { startsAt: studioLocalTimeToUtc('2026-08-25', '08:00', TZ) },
    });
    expect(extra?.status).toBe(ClassStatus.CANCELLED);
  });

  it('updates instructor on same canonical slot', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const instA = await createUserWithPassword(prisma);
    const instB = await createUserWithPassword(prisma);
    await createMembership(prisma, instA.id, studio.id, Role.INSTRUCTOR);
    await createMembership(prisma, instB.id, studio.id, Role.INSTRUCTOR);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00', { instructorId: instB.id });
    const target = await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25', '07:00', {
      instructorId: instA.id,
    });
    const admin = await seedAdmin(studio.id);

    await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: [TARGET_WEEK],
        confirmWarnings: true,
      },
      admin.id,
    );

    const updated = await prisma.scheduledClass.findUnique({ where: { id: target.id } });
    expect(updated?.instructorId).toBe(instB.id);
    expect(updated?.id).toBe(target.id);
  });

  it('blocks capacity below bookings on update', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00', { capacity: 1 });
    const target = await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25', '07:00', {
      capacity: 10,
    });
    const memberA = await createUserWithPassword(prisma);
    const memberB = await createUserWithPassword(prisma);
    await createMembership(prisma, memberA.id, studio.id, Role.STAFF);
    await createMembership(prisma, memberB.id, studio.id, Role.STAFF);
    await createConfirmedBooking(prisma, studio.id, target.id, memberA.id);
    await createConfirmedBooking(prisma, studio.id, target.id, memberB.id);
    const admin = await seedAdmin(studio.id);

    await expect(
      ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStarts: [TARGET_WEEK],
          confirmWarnings: true,
        },
        admin.id,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('blocks extra target class with bookings from reconciliation', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00');
    const extra = await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25', '08:00');
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.STAFF);
    await createConfirmedBooking(prisma, studio.id, extra.id, member.id);
    const admin = await seedAdmin(studio.id);

    await expect(
      ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStarts: [TARGET_WEEK],
          confirmWarnings: true,
          confirmRemovals: true,
        },
        admin.id,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('marks series-linked target occurrence DETACHED when updated', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const template = await prisma.scheduleTemplate.create({
      data: {
        studioId: studio.id,
        classTemplateId: tpl.id,
        dayOfWeek: 2,
        startTime: '07:00',
        startsAt: null,
        intervalWeeks: 1,
        active: true,
      },
    });
    const instA = await createUserWithPassword(prisma);
    const instB = await createUserWithPassword(prisma);
    await createMembership(prisma, instA.id, studio.id, Role.INSTRUCTOR);
    await createMembership(prisma, instB.id, studio.id, Role.INSTRUCTOR);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00', { instructorId: instB.id });
    const target = await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25', '07:00', {
      instructorId: instA.id,
    });
    await prisma.scheduledClass.update({
      where: { id: target.id },
      data: { scheduleTemplateId: template.id },
    });
    const admin = await seedAdmin(studio.id);

    await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: [TARGET_WEEK],
        confirmWarnings: true,
      },
      admin.id,
    );

    const updated = await prisma.scheduledClass.findUnique({ where: { id: target.id } });
    expect(updated?.exceptionKind).toBe(ScheduleOccurrenceExceptionKind.DETACHED);
    expect(updated?.scheduleTemplateId).toBe(template.id);
  });

  it('does not touch source week or unselected future weeks', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18');
    await seedSourceWeekClass(studio.id, tpl.id, '2026-09-01', '07:00');
    const admin = await seedAdmin(studio.id);

    await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: [TARGET_WEEK],
        confirmWarnings: true,
      },
      admin.id,
    );

    const untouched = await prisma.scheduledClass.findFirst({
      where: { startsAt: studioLocalTimeToUtc('2026-09-01', '07:00', TZ) },
    });
    expect(untouched?.status).toBe(ClassStatus.SCHEDULED);
    const sourceWeekCount = await prisma.scheduledClass.count({
      where: {
        studioId: studio.id,
        startsAt: {
          gte: studioLocalDateKeyToUtcAnchor(SOURCE_WEEK, TZ),
          lt: studioLocalDateKeyToUtcAnchor('2026-08-24', TZ),
        },
      },
    });
    expect(sourceWeekCount).toBe(1);
  });

  it('retry same duplicate-week request is idempotent', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18');
    const admin = await seedAdmin(studio.id);
    const key = 'dup-week-reconcile-key';

    const first = await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        repeatWeeks: 1,
        confirmWarnings: true,
        idempotencyKey: key,
      },
      admin.id,
    );
    const second = await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        repeatWeeks: 1,
        confirmWarnings: true,
        idempotencyKey: key,
      },
      admin.id,
    );

    expect(first.createdCount).toBe(1);
    expect(second.idempotentReplay).toBe(true);
  });

  it('generator after reconciliation does not recreate removed slot', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await prisma.scheduleTemplate.create({
      data: {
        studioId: studio.id,
        classTemplateId: tpl.id,
        dayOfWeek: 2,
        startTime: '08:00',
        startsAt: null,
        intervalWeeks: 1,
        active: true,
      },
    });
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00');
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25', '08:00');
    const admin = await seedAdmin(studio.id);

    await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: [TARGET_WEEK],
        confirmWarnings: true,
        confirmRemovals: true,
      },
      admin.id,
    );

    const before = await prisma.scheduledClass.count({
      where: {
        studioId: studio.id,
        startsAt: studioLocalTimeToUtc('2026-08-25', '08:00', TZ),
      },
    });
    await generatorService.generateRange(
      studio.id,
      studioLocalDateKeyToUtcAnchor(TARGET_WEEK, TZ),
      studioLocalDateKeyToUtcAnchor('2026-08-31', TZ),
      { isDryRun: false, triggeredBy: 'MANUAL' },
    );
    const after = await prisma.scheduledClass.count({
      where: {
        studioId: studio.id,
        startsAt: studioLocalTimeToUtc('2026-08-25', '08:00', TZ),
      },
    });
    expect(before).toBe(after);
  });

  describe('release safety hardening', () => {
    it('blocks extra target class with attendance from reconciliation', async () => {
      const studio = await createStudio(prisma, { timezone: TZ });
      const tpl = await createClassTemplate(prisma, studio.id, { name: 'Full Body' });
      await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00');
      const extra = await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25', '08:00');
      const member = await createUserWithPassword(prisma);
      await createMembership(prisma, member.id, studio.id, Role.STAFF);
      await prisma.attendance.create({
        data: {
          studioId: studio.id,
          scheduledClassId: extra.id,
          userId: member.id,
          method: 'QR',
          checkedInAt: new Date(),
        },
      });
      const admin = await seedAdmin(studio.id);

      const preview = await ops.previewDuplicateWeek(studio.id, {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: [TARGET_WEEK],
      });
      expect(preview.blockedCount).toBeGreaterThan(0);
      expect(
        preview.reconciliationItems?.some((i) => i.kind === 'BLOCK'),
      ).toBe(true);

      await expect(
        ops.executeDuplicateWeek(
          studio.id,
          {
            sourceWeekStart: SOURCE_WEEK,
            targetWeekStarts: [TARGET_WEEK],
            confirmWarnings: true,
            confirmRemovals: true,
          },
          admin.id,
        ),
      ).rejects.toMatchObject({ status: 409 });

      const row = await prisma.scheduledClass.findUnique({ where: { id: extra.id } });
      expect(row?.status).toBe(ClassStatus.SCHEDULED);
      const attendance = await prisma.attendance.count({ where: { scheduledClassId: extra.id } });
      expect(attendance).toBe(1);
    });

    it('does not mutate a different studio during reconciliation', async () => {
      const studioA = await createStudio(prisma, { timezone: TZ });
      const studioB = await createStudio(prisma, { timezone: TZ });
      const tplA = await createClassTemplate(prisma, studioA.id);
      const tplB = await createClassTemplate(prisma, studioB.id);
      await seedSourceWeekClass(studioA.id, tplA.id, '2026-08-18', '07:00');
      const studioBBefore = await seedSourceWeekClass(studioB.id, tplB.id, '2026-08-25', '07:00');
      const admin = await seedAdmin(studioA.id);

      await ops.executeDuplicateWeek(
        studioA.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStarts: [TARGET_WEEK],
          confirmWarnings: true,
        },
        admin.id,
      );

      const studioBAfter = await prisma.scheduledClass.findUnique({
        where: { id: studioBBefore.id },
      });
      expect(studioBAfter?.status).toBe(ClassStatus.SCHEDULED);
      expect(studioBAfter?.instructorId).toBe(studioBBefore.instructorId);
    });

    it('reactivates an empty cancelled canonical slot when later desired', async () => {
      const studio = await createStudio(prisma, { timezone: TZ });
      const tpl = await createClassTemplate(prisma, studio.id);
      await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00');
      const cancelled = await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25', '07:00', {
        status: ClassStatus.CANCELLED,
      });
      const admin = await seedAdmin(studio.id);

      const result = await ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStarts: [TARGET_WEEK],
          confirmWarnings: true,
        },
        admin.id,
      );

      expect(result.createdCount).toBe(0);
      expect(result.updatedCount).toBe(1);
      const row = await prisma.scheduledClass.findUnique({ where: { id: cancelled.id } });
      expect(row?.status).toBe(ClassStatus.SCHEDULED);
      const count = await prisma.scheduledClass.count({
        where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
      });
      expect(count).toBe(1);
    });

    it('blocks reactivation when cancelled slot has booking history', async () => {
      const studio = await createStudio(prisma, { timezone: TZ });
      const tpl = await createClassTemplate(prisma, studio.id);
      await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00');
      const cancelled = await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25', '07:00', {
        status: ClassStatus.CANCELLED,
      });
      const member = await createUserWithPassword(prisma);
      await createMembership(prisma, member.id, studio.id, Role.STAFF);
      await createConfirmedBooking(prisma, studio.id, cancelled.id, member.id);
      const admin = await seedAdmin(studio.id);

      await expect(
        ops.executeDuplicateWeek(
          studio.id,
          {
            sourceWeekStart: SOURCE_WEEK,
            targetWeekStarts: [TARGET_WEEK],
            confirmWarnings: true,
          },
          admin.id,
        ),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('preserves Mexico City local time when copying across weeks', async () => {
      const studio = await createStudio(prisma, { timezone: TZ });
      const tpl = await createClassTemplate(prisma, studio.id, { name: 'Sunday Flow' });
      await seedSourceWeekClass(studio.id, tpl.id, '2026-08-23', '07:00');
      const admin = await seedAdmin(studio.id);

      await ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: '2026-08-17',
          targetWeekStarts: ['2026-08-24'],
          confirmWarnings: true,
        },
        admin.id,
      );

      const copy = await prisma.scheduledClass.findFirst({
        where: { startsAt: studioLocalTimeToUtc('2026-08-30', '07:00', TZ) },
      });
      expect(copy).toBeTruthy();
      expect(copy?.startsAt.toISOString()).toBe(
        studioLocalTimeToUtc('2026-08-30', '07:00', TZ).toISOString(),
      );
    });

    it('preserves New York local time across DST transition', async () => {
      const NY = 'America/New_York';
      const studio = await createStudio(prisma, { timezone: NY });
      const tpl = await createClassTemplate(prisma, studio.id, { name: 'Sunday Flow' });
      await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: studioLocalTimeToUtc('2026-03-01', '07:00', NY),
        endsAt: studioLocalTimeToUtc('2026-03-01', '08:00', NY),
      });
      const admin = await seedAdmin(studio.id);

      await ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: '2026-02-23',
          targetWeekStarts: ['2026-03-02'],
          confirmWarnings: true,
        },
        admin.id,
      );

      const copy = await prisma.scheduledClass.findFirst({
        where: { startsAt: studioLocalTimeToUtc('2026-03-08', '07:00', NY) },
      });
      expect(copy).toBeTruthy();
      expect(copy?.startsAt.toISOString()).not.toBe(
        studioLocalTimeToUtc('2026-03-01', '07:00', NY).toISOString(),
      );
    });

    it('allows safe capacity increase on desired occurrence with bookings', async () => {
      const studio = await createStudio(prisma, { timezone: TZ });
      const tpl = await createClassTemplate(prisma, studio.id);
      await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00', { capacity: 20 });
      const target = await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25', '07:00', {
        capacity: 10,
      });
      const member = await createUserWithPassword(prisma);
      await createMembership(prisma, member.id, studio.id, Role.STAFF);
      const booking = await createConfirmedBooking(prisma, studio.id, target.id, member.id);
      const admin = await seedAdmin(studio.id);

      const result = await ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStarts: [TARGET_WEEK],
          confirmWarnings: true,
        },
        admin.id,
      );

      expect(result.updatedCount).toBe(1);
      const row = await prisma.scheduledClass.findUnique({ where: { id: target.id } });
      expect(row?.capacity).toBe(20);
      const bookingAfter = await prisma.booking.findUnique({ where: { id: booking.id } });
      expect(bookingAfter?.scheduledClassId).toBe(target.id);
    });

    it('does not copy source bookings attendance or waitlist to target week', async () => {
      const studio = await createStudio(prisma, { timezone: TZ });
      const tpl = await createClassTemplate(prisma, studio.id);
      const source = await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00');
      const member = await createUserWithPassword(prisma);
      await createMembership(prisma, member.id, studio.id, Role.STAFF);
      await createConfirmedBooking(prisma, studio.id, source.id, member.id);
      await prisma.attendance.create({
        data: {
          studioId: studio.id,
          scheduledClassId: source.id,
          userId: member.id,
          method: 'QR',
          checkedInAt: new Date(),
        },
      });
      await prisma.waitlistEntry.create({
        data: {
          studioId: studio.id,
          scheduledClassId: source.id,
          userId: member.id,
          status: 'WAITING',
          position: 1,
        },
      });
      const admin = await seedAdmin(studio.id);

      await ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStarts: [TARGET_WEEK],
          confirmWarnings: true,
        },
        admin.id,
      );

      const copy = await prisma.scheduledClass.findFirst({
        where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
        include: {
          _count: { select: { bookings: true, attendances: true, waitlist: true } },
        },
      });
      expect(copy?._count.bookings).toBe(0);
      expect(copy?._count.attendances).toBe(0);
      expect(copy?._count.waitlist).toBe(0);
    });

    it('serializes concurrent duplicate-week operations on the same target week', async () => {
      const studio = await createStudio(prisma, { timezone: TZ });
      const tpl = await createClassTemplate(prisma, studio.id);
      await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00');
      const admin = await seedAdmin(studio.id);

      const [a, b] = await Promise.all([
        ops.executeDuplicateWeek(
          studio.id,
          {
            sourceWeekStart: SOURCE_WEEK,
            targetWeekStarts: [TARGET_WEEK],
            confirmWarnings: true,
          },
          admin.id,
        ),
        ops.executeDuplicateWeek(
          studio.id,
          {
            sourceWeekStart: SOURCE_WEEK,
            targetWeekStarts: [TARGET_WEEK],
            confirmWarnings: true,
          },
          admin.id,
        ),
      ]);

      expect(a.createdCount + b.createdCount).toBeLessThanOrEqual(1);
      const rows = await prisma.scheduledClass.findMany({
        where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
      });
      expect(rows).toHaveLength(1);
    });

    it('completes overlapping multi-week operations without deadlock', async () => {
      const studio = await createStudio(prisma, { timezone: TZ });
      const tpl = await createClassTemplate(prisma, studio.id);
      await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18', '07:00');
      await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25', '07:00');
      const admin = await seedAdmin(studio.id);

      const [a, b] = await Promise.all([
        ops.executeDuplicateWeek(
          studio.id,
          {
            sourceWeekStart: SOURCE_WEEK,
            targetWeekStarts: ['2026-08-24', '2026-08-31'],
            confirmWarnings: true,
          },
          admin.id,
        ),
        ops.executeDuplicateWeek(
          studio.id,
          {
            sourceWeekStart: '2026-08-24',
            targetWeekStarts: ['2026-08-31', '2026-08-24'],
            confirmWarnings: true,
          },
          admin.id,
        ),
      ]);

      expect(a.createdCount + b.createdCount).toBeGreaterThanOrEqual(0);
      const weekOne = await prisma.scheduledClass.count({
        where: { startsAt: studioLocalTimeToUtc('2026-09-01', '07:00', TZ) },
      });
      expect(weekOne).toBeGreaterThanOrEqual(1);
    });
  });
});
