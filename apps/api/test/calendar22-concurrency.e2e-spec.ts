import type { INestApplication } from '@nestjs/common';
import { ClassStatus, Role } from '@prisma/client';
import { ScheduleGeneratorService } from '../src/schedule-generator/schedule-generator.service';
import { ScheduleOperationsService } from '../src/schedule/schedule-operations.service';
import { BulkScheduleOperation } from '../src/schedule/dto/schedule-operations.dto';
import { ScheduleService } from '../src/schedule/schedule.service';
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

describe('Calendar 2.2 concurrency hardening (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ops: ScheduleOperationsService;
  let generatorService: ScheduleGeneratorService;
  let scheduleService: ScheduleService;

  const TZ = 'America/Mexico_City';
  const SOURCE_WEEK = '2026-08-17';
  const ADMIN_PASS = 'password12';

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ops = app.get(ScheduleOperationsService);
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
    const admin = await createUserWithPassword(prisma, {
      email: `admin-${Date.now()}-${Math.random()}@e2e.local`,
      password: ADMIN_PASS,
    });
    await createMembership(prisma, admin.id, studioId, Role.ADMIN);
    return admin;
  }

  async function seedSourceClass(studioId: string, templateId: string) {
    return createScheduledClass(prisma, studioId, templateId, {
      startsAt: studioLocalTimeToUtc('2026-08-18', '07:00', TZ),
      endsAt: studioLocalTimeToUtc('2026-08-18', '08:00', TZ),
      capacity: 12,
    });
  }

  it('concurrent duplicate-class requests create exactly one target occurrence', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const source = await seedSourceClass(studio.id, tpl.id);
    const admin = await seedAdmin(studio.id);
    const target = { date: '2026-08-25', time: '07:00' };

    const [a, b] = await Promise.all([
      ops.executeDuplicateClass(
        studio.id,
        source.id,
        { localStart: target, confirmWarnings: true },
        admin.id,
      ),
      ops.executeDuplicateClass(
        studio.id,
        source.id,
        { localStart: target, confirmWarnings: true },
        admin.id,
      ),
    ]);

    const totalCreated = a.createdCount + b.createdCount;
    expect(totalCreated).toBe(1);

    const rows = await prisma.scheduledClass.findMany({
      where: { startsAt: studioLocalTimeToUtc(target.date, target.time, TZ) },
    });
    expect(rows).toHaveLength(1);
  });

  it('concurrent duplicate-week requests create no duplicate target occurrences', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceClass(studio.id, tpl.id);
    const admin = await seedAdmin(studio.id);

    const [a, b] = await Promise.all([
      ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStarts: ['2026-08-24'],
          confirmWarnings: true,
        },
        admin.id,
      ),
      ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStarts: ['2026-08-24'],
          confirmWarnings: true,
        },
        admin.id,
      ),
    ]);

    expect(a.createdCount + b.createdCount).toBe(1);
    const rows = await prisma.scheduledClass.findMany({
      where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
    });
    expect(rows).toHaveLength(1);
  });

  it('same idempotencyKey concurrent requests produce one mutation and one audit', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceClass(studio.id, tpl.id);
    const admin = await seedAdmin(studio.id);
    const key = 'concurrent-idem-key';

    const [a, b] = await Promise.all([
      ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          repeatWeeks: 1,
          confirmWarnings: true,
          idempotencyKey: key,
        },
        admin.id,
      ),
      ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          repeatWeeks: 1,
          confirmWarnings: true,
          idempotencyKey: key,
        },
        admin.id,
      ),
    ]);

    expect(a.createdCount + b.createdCount).toBeGreaterThanOrEqual(1);
    expect(a.idempotentReplay || b.idempotentReplay).toBe(true);

    const rows = await prisma.scheduledClass.findMany({
      where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
    });
    expect(rows).toHaveLength(1);

    const audits = await prisma.auditLog.findMany({
      where: { studioId: studio.id, action: 'SCHEDULE_WEEK_DUPLICATED' },
    });
    expect(audits).toHaveLength(1);
  });

  it('different idempotency keys targeting same slots still produce one occurrence', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceClass(studio.id, tpl.id);
    const admin = await seedAdmin(studio.id);

    await Promise.all([
      ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          repeatWeeks: 1,
          confirmWarnings: true,
          idempotencyKey: 'key-a',
        },
        admin.id,
      ),
      ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          repeatWeeks: 1,
          confirmWarnings: true,
          idempotencyKey: 'key-b',
        },
        admin.id,
      ),
    ]);

    const rows = await prisma.scheduledClass.findMany({
      where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
    });
    expect(rows).toHaveLength(1);
  });

  it('generator and duplicate-week racing on same slot yield one occurrence', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await prisma.scheduleTemplate.create({
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
    await seedSourceClass(studio.id, tpl.id);
    const admin = await seedAdmin(studio.id);

    await Promise.all([
      ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStarts: ['2026-08-24'],
          confirmWarnings: true,
        },
        admin.id,
      ),
      generatorService.generateRange(
        studio.id,
        studioLocalDateKeyToUtcAnchor('2026-08-24', TZ),
        studioLocalDateKeyToUtcAnchor('2026-08-31', TZ),
        { isDryRun: false, triggeredBy: 'MANUAL' },
      ),
    ]);

    const rows = await prisma.scheduledClass.findMany({
      where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
    });
    expect(rows).toHaveLength(1);
  });

  it('concurrent bulk duplicate creates no duplicate occurrences', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const cls = await seedSourceClass(studio.id, tpl.id);
    const admin = await seedAdmin(studio.id);

    const [a, b] = await Promise.all([
      ops.executeBulk(
        studio.id,
        {
          scheduledClassIds: [cls.id],
          operation: BulkScheduleOperation.DUPLICATE,
          weekOffsetWeeks: 1,
          confirmWarnings: true,
        },
        admin.id,
      ),
      ops.executeBulk(
        studio.id,
        {
          scheduledClassIds: [cls.id],
          operation: BulkScheduleOperation.DUPLICATE,
          weekOffsetWeeks: 1,
          confirmWarnings: true,
        },
        admin.id,
      ),
    ]);

    expect(a.createdCount + b.createdCount).toBe(1);
    const rows = await prisma.scheduledClass.findMany({
      where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
    });
    expect(rows).toHaveLength(1);
  });

  it('does not overwrite booking-bearing target occurrence', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceClass(studio.id, tpl.id);
    const existing = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ),
      endsAt: studioLocalTimeToUtc('2026-08-25', '08:00', TZ),
      capacity: 8,
    });
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.STAFF);
    const booking = await createConfirmedBooking(prisma, studio.id, existing.id, member.id);
    const admin = await seedAdmin(studio.id);

    const result = await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: ['2026-08-24'],
        confirmWarnings: true,
      },
      admin.id,
    );

    expect(result.createdCount).toBe(0);
    expect(result.updatedCount).toBe(1);
    const row = await prisma.scheduledClass.findUnique({ where: { id: existing.id } });
    expect(row?.capacity).toBe(12);
    const bookingAfter = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(bookingAfter?.scheduledClassId).toBe(existing.id);
  });

  it('duplicate with attendance on source does not copy attendance/bookings/waitlist', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const source = await seedSourceClass(studio.id, tpl.id);
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

    const result = await ops.executeDuplicateClass(
      studio.id,
      source.id,
      { localStart: { date: '2026-08-25', time: '07:00' }, confirmWarnings: true },
      admin.id,
    );

    expect(result.createdCount).toBe(1);
    const copy = await prisma.scheduledClass.findFirst({
      where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
      include: {
        _count: { select: { bookings: true, attendances: true, waitlist: true } },
      },
    });
    expect(copy?.status).toBe(ClassStatus.SCHEDULED);
    expect(copy?._count.bookings).toBe(0);
    expect(copy?._count.attendances).toBe(0);
    expect(copy?._count.waitlist).toBe(0);
  });

  it('public schedule shape unchanged after duplicate week', async () => {
    const studio = await createStudio(prisma, { timezone: TZ, slug: `pub-${Date.now()}` });
    const tpl = await createClassTemplate(prisma, studio.id, { name: 'Booty Lab' });
    await seedSourceClass(studio.id, tpl.id);
    const admin = await seedAdmin(studio.id);

    await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        repeatWeeks: 1,
        confirmWarnings: true,
      },
      admin.id,
    );

    const rows = await scheduleService.listPublicSchedule(studio.id, {
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
    });

    expect(rows.length).toBeGreaterThan(0);
    const sample = rows[0]!;
    expect(sample).toMatchObject({
      id: expect.any(String),
      startsAt: expect.any(Date),
      endsAt: expect.any(Date),
      capacity: expect.any(Number),
      status: ClassStatus.SCHEDULED,
      bookedCount: expect.any(Number),
    });
    expect(sample.classTemplate).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
    });
    expect(sample.scheduleTemplateId ?? null).toBeNull();
    expect(sample.exceptionKind ?? null).toBeNull();
  });
});
