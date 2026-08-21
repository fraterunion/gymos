import type { INestApplication } from '@nestjs/common';
import {
  ClassStatus,
  Role,
  ScheduleOccurrenceExceptionKind,
} from '@prisma/client';
import request from 'supertest';
import { ScheduleGeneratorService } from '../src/schedule-generator/schedule-generator.service';
import { ScheduleOperationsService } from '../src/schedule/schedule-operations.service';
import { BulkScheduleOperation } from '../src/schedule/dto/schedule-operations.dto';
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

describe('Calendar 2.2 schedule operations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ops: ScheduleOperationsService;
  let generatorService: ScheduleGeneratorService;

  const TZ = 'America/Mexico_City';
  const SOURCE_WEEK = '2026-08-17';
  const ADMIN_PASS = 'password12';

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

  async function seedSourceWeekClass(
    studioId: string,
    templateId: string,
    localDate: string,
    time = '07:00',
  ) {
    return createScheduledClass(prisma, studioId, templateId, {
      startsAt: studioLocalTimeToUtc(localDate, time, TZ),
      endsAt: studioLocalTimeToUtc(localDate, '08:00', TZ),
      capacity: 12,
    });
  }

  it('duplicates one standalone class', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const source = await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18');
    const admin = await seedAdmin(studio.id);

    const result = await ops.executeDuplicateClass(
      studio.id,
      source.id,
      {
        localStart: { date: '2026-08-25', time: '07:00' },
        confirmWarnings: true,
      },
      admin.id,
    );

    expect(result.createdCount).toBe(1);
    const copy = await prisma.scheduledClass.findFirst({
      where: {
        studioId: studio.id,
        classTemplateId: tpl.id,
        startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ),
      },
    });
    expect(copy).toBeTruthy();
    expect(copy?.scheduleTemplateId).toBeNull();
  });

  it('duplicates source week to one future week', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18');
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

    expect(result.createdCount).toBe(1);
    const copy = await prisma.scheduledClass.findFirst({
      where: {
        startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ),
      },
    });
    expect(copy?.scheduleTemplateId).toBeNull();
  });

  it('duplicates source week to multiple future weeks', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18');
    const admin = await seedAdmin(studio.id);

    const result = await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: ['2026-08-24', '2026-08-31'],
        confirmWarnings: true,
      },
      admin.id,
    );

    expect(result.createdCount).toBe(2);
  });

  it('retry same duplicate-week request is idempotent', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18');
    const admin = await seedAdmin(studio.id);
    const key = 'dup-week-key-1';

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
    const count = await prisma.scheduledClass.count({
      where: { studioId: studio.id, classTemplateId: tpl.id },
    });
    expect(count).toBe(2);
  });

  it('skips existing destination occurrence instead of overwriting', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18');
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-25');
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

    expect(result.reusedCount).toBe(1);
    expect(result.createdCount).toBe(0);
    const atSlot = await prisma.scheduledClass.findMany({
      where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
    });
    expect(atSlot).toHaveLength(1);
  });

  it('does not copy bookings when duplicating class', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.STAFF);
    const source = await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18');
    await createConfirmedBooking(prisma, studio.id, source.id, member.id);
    const admin = await seedAdmin(studio.id);

    await ops.executeDuplicateClass(
      studio.id,
      source.id,
      { localStart: { date: '2026-08-25', time: '07:00' }, confirmWarnings: true },
      admin.id,
    );

    const bookingsOnCopy = await prisma.booking.count({
      where: {
        scheduledClass: {
          startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ),
        },
      },
    });
    expect(bookingsOnCopy).toBe(0);
  });

  it('blocks exact duplicate on class duplicate', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const source = await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18');
    const admin = await seedAdmin(studio.id);

    await expect(
      ops.executeDuplicateClass(
        studio.id,
        source.id,
        { localStart: { date: '2026-08-18', time: '07:00' }, confirmWarnings: true },
        admin.id,
      ),
    ).resolves.toMatchObject({ createdCount: 0, skippedCount: 1 });
  });

  it('bulk instructor change preserves occurrence IDs and bookings', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const instA = await createUserWithPassword(prisma);
    const instB = await createUserWithPassword(prisma);
    await createMembership(prisma, instA.id, studio.id, Role.INSTRUCTOR);
    await createMembership(prisma, instB.id, studio.id, Role.INSTRUCTOR);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc('2026-09-01', '07:00', TZ),
      endsAt: studioLocalTimeToUtc('2026-09-01', '08:00', TZ),
      instructorId: instA.id,
    });
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.STAFF);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const admin = await seedAdmin(studio.id);

    await ops.executeBulk(
      studio.id,
      {
        scheduledClassIds: [cls.id],
        operation: BulkScheduleOperation.CHANGE_INSTRUCTOR,
        instructorId: instB.id,
        confirmWarnings: true,
      },
      admin.id,
    );

    const updated = await prisma.scheduledClass.findUnique({ where: { id: cls.id } });
    expect(updated?.instructorId).toBe(instB.id);
    const bookingAfter = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(bookingAfter?.scheduledClassId).toBe(cls.id);
  });

  it('bulk capacity below booked count blocks', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc('2026-09-01', '07:00', TZ),
      endsAt: studioLocalTimeToUtc('2026-09-01', '08:00', TZ),
      capacity: 10,
    });
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.STAFF);
    await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const admin = await seedAdmin(studio.id);

    await expect(
      ops.executeBulk(
        studio.id,
        {
          scheduledClassIds: [cls.id],
          operation: BulkScheduleOperation.CHANGE_CAPACITY,
          capacity: 0,
          confirmWarnings: true,
        },
        admin.id,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('bulk cancel soft-cancels with reservation confirm', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id);
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.STAFF);
    await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const admin = await seedAdmin(studio.id);

    await ops.executeBulk(
      studio.id,
      {
        scheduledClassIds: [cls.id],
        operation: BulkScheduleOperation.CANCEL,
        confirmWarnings: true,
        confirmReservations: true,
      },
      admin.id,
    );

    const row = await prisma.scheduledClass.findUnique({ where: { id: cls.id } });
    expect(row?.status).toBe(ClassStatus.CANCELLED);
    const booking = await prisma.booking.findFirst({
      where: { scheduledClassId: cls.id, userId: member.id },
    });
    expect(booking?.status).toBe('CANCELLED');
  });

  it('bulk edit on recurring occurrence marks DETACHED', async () => {
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
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc('2026-09-01', '07:00', TZ),
      endsAt: studioLocalTimeToUtc('2026-09-01', '08:00', TZ),
    });
    await prisma.scheduledClass.update({
      where: { id: cls.id },
      data: { scheduleTemplateId: template.id },
    });
    const inst = await createUserWithPassword(prisma);
    await createMembership(prisma, inst.id, studio.id, Role.INSTRUCTOR);
    const admin = await seedAdmin(studio.id);

    await ops.executeBulk(
      studio.id,
      {
        scheduledClassIds: [cls.id],
        operation: BulkScheduleOperation.CHANGE_INSTRUCTOR,
        instructorId: inst.id,
        confirmWarnings: true,
      },
      admin.id,
    );

    const updated = await prisma.scheduledClass.findUnique({ where: { id: cls.id } });
    expect(updated?.exceptionKind).toBe(ScheduleOccurrenceExceptionKind.DETACHED);
  });

  it('rejects STAFF bulk operations via HTTP', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const staff = await createUserWithPassword(prisma, {
      email: 'staff-bulk@e2e.local',
      password: ADMIN_PASS,
    });
    await createMembership(prisma, staff.id, studio.id, Role.STAFF);
    const token = await loginToken(staff.email);
    const tpl = await createClassTemplate(prisma, studio.id);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/schedule-operations/bulk`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        scheduledClassIds: [cls.id],
        operation: BulkScheduleOperation.CANCEL,
        confirmWarnings: true,
        confirmReservations: true,
      })
      .expect(403);
  });

  it('generator after duplicate week creates no duplicates at copied slots', async () => {
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
    await seedSourceWeekClass(studio.id, tpl.id, '2026-08-18');
    const admin = await seedAdmin(studio.id);

    await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts: ['2026-08-24'],
        confirmWarnings: true,
      },
      admin.id,
    );

    const before = await prisma.scheduledClass.count({ where: { studioId: studio.id } });
    await generatorService.generateRange(
      studio.id,
      studioLocalDateKeyToUtcAnchor('2026-08-24', TZ),
      studioLocalDateKeyToUtcAnchor('2026-09-01', TZ),
      { isDryRun: false, triggeredBy: 'MANUAL' },
    );
    const after = await prisma.scheduledClass.count({ where: { studioId: studio.id } });
    expect(after).toBeGreaterThanOrEqual(before);
    const dupes = await prisma.scheduledClass.findMany({
      where: { startsAt: studioLocalTimeToUtc('2026-08-25', '07:00', TZ) },
    });
    expect(dupes).toHaveLength(1);
  });

  it('enforces studio isolation on bulk targets', async () => {
    const studioA = await createStudio(prisma, { timezone: TZ });
    const studioB = await createStudio(prisma, { timezone: TZ });
    const tplB = await createClassTemplate(prisma, studioB.id);
    const clsB = await createScheduledClass(prisma, studioB.id, tplB.id);
    const admin = await seedAdmin(studioA.id);

    await expect(
      ops.executeBulk(
        studioA.id,
        {
          scheduledClassIds: [clsB.id],
          operation: BulkScheduleOperation.CANCEL,
          confirmWarnings: true,
        },
        admin.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('surfaces instructor overlap as warning on duplicate week preview', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tplA = await createClassTemplate(prisma, studio.id, { name: 'A' });
    const tplB = await createClassTemplate(prisma, studio.id, { name: 'B' });
    const instructor = await createUserWithPassword(prisma);
    await createMembership(prisma, instructor.id, studio.id, Role.INSTRUCTOR);
    await createScheduledClass(prisma, studio.id, tplA.id, {
      startsAt: studioLocalTimeToUtc('2026-08-18', '07:00', TZ),
      endsAt: studioLocalTimeToUtc('2026-08-18', '08:00', TZ),
      instructorId: instructor.id,
    });
    await createScheduledClass(prisma, studio.id, tplB.id, {
      startsAt: studioLocalTimeToUtc('2026-08-25', '07:30', TZ),
      endsAt: studioLocalTimeToUtc('2026-08-25', '08:30', TZ),
      instructorId: instructor.id,
    });

    const preview = await ops.previewDuplicateWeek(studio.id, {
      sourceWeekStart: SOURCE_WEEK,
      targetWeekStarts: ['2026-08-24'],
    });
    expect(preview.warningCount).toBeGreaterThan(0);
  });

  it('safe bulk capacity update succeeds', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, { capacity: 10 });
    const admin = await seedAdmin(studio.id);

    await ops.executeBulk(
      studio.id,
      {
        scheduledClassIds: [cls.id],
        operation: BulkScheduleOperation.CHANGE_CAPACITY,
        capacity: 20,
        confirmWarnings: true,
      },
      admin.id,
    );

    const row = await prisma.scheduledClass.findUnique({ where: { id: cls.id } });
    expect(row?.capacity).toBe(20);
  });

  it('bulk time move with bookings requires confirmation', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id);
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.STAFF);
    await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const admin = await seedAdmin(studio.id);

    await expect(
      ops.executeBulk(
        studio.id,
        {
          scheduledClassIds: [cls.id],
          operation: BulkScheduleOperation.MOVE_TIME,
          timeDeltaMinutes: 15,
          confirmWarnings: true,
        },
        admin.id,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('bulk time move preserves booking relation when confirmed', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc('2026-09-01', '07:00', TZ),
      endsAt: studioLocalTimeToUtc('2026-09-01', '08:00', TZ),
    });
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.STAFF);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const admin = await seedAdmin(studio.id);

    await ops.executeBulk(
      studio.id,
      {
        scheduledClassIds: [cls.id],
        operation: BulkScheduleOperation.MOVE_TIME,
        timeDeltaMinutes: 15,
        confirmWarnings: true,
        confirmReservations: true,
      },
      admin.id,
    );

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after?.scheduledClassId).toBe(cls.id);
    const moved = await prisma.scheduledClass.findUnique({ where: { id: cls.id } });
    expect(moved?.startsAt).toEqual(studioLocalTimeToUtc('2026-09-01', '07:15', TZ));
  });

  it('duplicate week preserves studio-local times across DST boundary week', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc('2026-04-05', '07:00', TZ),
      endsAt: studioLocalTimeToUtc('2026-04-05', '08:00', TZ),
    });
    const admin = await seedAdmin(studio.id);

    await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: '2026-03-30',
        targetWeekStarts: ['2026-04-06'],
        confirmWarnings: true,
      },
      admin.id,
    );

    const copy = await prisma.scheduledClass.findFirst({
      where: { startsAt: studioLocalTimeToUtc('2026-04-12', '07:00', TZ) },
    });
    expect(copy).toBeTruthy();
  });
});
