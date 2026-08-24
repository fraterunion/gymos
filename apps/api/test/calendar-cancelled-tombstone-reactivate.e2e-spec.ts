import type { INestApplication } from '@nestjs/common';
import { CheckInMethod, CheckInType, ClassStatus, Role, ScheduleOccurrenceExceptionKind, WaitlistStatus } from '@prisma/client';
import request from 'supertest';
import { ScheduleService } from '../src/schedule/schedule.service';
import { SCHEDULE_SLOT_CANCELLED_WITH_HISTORY_CODE } from '../src/schedule/schedule-occurrence-history';
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
import { studioLocalTimeToUtc } from '../src/common/date/studio-local-date';

async function loginAccessToken(
  nestApp: INestApplication,
  email: string,
  password: string,
): Promise<string> {
  const res = await request(nestApp.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

/**
 * Calendar CANCELLED tombstone reactivation on POST /schedule.
 * Empty CANCELLED rows must be reactivated in place; history-bearing CANCELLED rows must conflict.
 */
describe('Calendar cancelled tombstone reactivation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let scheduleService: ScheduleService;

  const TZ = 'America/Mexico_City';
  const DATE = '2026-08-24';
  const TIME = '06:00';

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    scheduleService = app.get(ScheduleService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedStudioAdmin() {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id, {
      name: 'Legs + HIIT',
      defaultCapacity: 10,
      durationMinutes: 60,
    });
    const admin = await createUserWithPassword(prisma, {
      email: `tomb-admin-${Date.now()}@e2e.local`,
    });
    await createMembership(prisma, admin.id, studio.id, Role.ADMIN);
    const token = await loginAccessToken(app, admin.email, admin.password);
    return { studio, tpl, admin, token };
  }

  function startsEnds() {
    const startsAt = studioLocalTimeToUtc(DATE, TIME, TZ);
    const endsAt = studioLocalTimeToUtc(DATE, '07:00', TZ);
    return { startsAt, endsAt };
  }

  async function createCancelledTombstone(
    studioId: string,
    templateId: string,
    overrides: { cancelReason?: string | null; capacity?: number } = {},
  ) {
    const { startsAt, endsAt } = startsEnds();
    return prisma.scheduledClass.create({
      data: {
        studioId,
        classTemplateId: templateId,
        startsAt,
        endsAt,
        capacity: overrides.capacity ?? 10,
        status: ClassStatus.CANCELLED,
        cancelReason: overrides.cancelReason ?? 'Removed by week reconciliation',
        instructorId: null,
        scheduleTemplateId: null,
        exceptionKind: null,
      },
    });
  }

  it('reactivates an empty CANCELLED tombstone with the same ScheduledClass id', async () => {
    const { studio, tpl, token } = await seedStudioAdmin();
    const tomb = await createCancelledTombstone(studio.id, tpl.id);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/schedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: tpl.id,
        localStart: { date: DATE, time: TIME },
        localEnd: { date: DATE, time: '07:00' },
        capacity: 12,
      })
      .expect(201);

    expect((res.body as { id: string }).id).toBe(tomb.id);
    expect((res.body as { status: string }).status).toBe(ClassStatus.SCHEDULED);
    expect((res.body as { capacity: number }).capacity).toBe(12);
    expect((res.body as { cancelReason: string | null }).cancelReason).toBeNull();

    const rows = await prisma.scheduledClass.findMany({
      where: { studioId: studio.id, classTemplateId: tpl.id, startsAt: startsEnds().startsAt },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(tomb.id);
    expect(rows[0]!.status).toBe(ClassStatus.SCHEDULED);
    expect(rows[0]!.cancelReason).toBeNull();
    expect(rows[0]!.capacity).toBe(12);
  });

  it('clears series linkage metadata when reactivating via one-off create', async () => {
    const { studio, tpl } = await seedStudioAdmin();
    const { startsAt, endsAt } = startsEnds();
    // Detached cancelled series child (empty) — create must not re-attach to a series.
    const series = await prisma.scheduleTemplate.create({
      data: {
        studioId: studio.id,
        classTemplateId: tpl.id,
        dayOfWeek: 1,
        startTime: TIME,
        intervalWeeks: 1,
        active: true,
        capacity: 10,
        startsAt: startsAt,
      },
    });
    const tomb = await prisma.scheduledClass.create({
      data: {
        studioId: studio.id,
        classTemplateId: tpl.id,
        startsAt,
        endsAt,
        capacity: 10,
        status: ClassStatus.CANCELLED,
        cancelReason: 'Removed by week reconciliation',
        scheduleTemplateId: series.id,
        exceptionKind: ScheduleOccurrenceExceptionKind.DETACHED,
      },
    });

    const reactivated = await scheduleService.createScheduledClass(studio.id, {
      templateId: tpl.id,
      localStart: { date: DATE, time: TIME },
      localEnd: { date: DATE, time: '07:00' },
      capacity: 10,
    });

    expect(reactivated.id).toBe(tomb.id);
    expect(reactivated.scheduleTemplateId).toBeNull();
    expect(reactivated.exceptionKind).toBeNull();
    expect(reactivated.status).toBe(ClassStatus.SCHEDULED);
  });

  it('conflicts when CANCELLED slot has a booking; leaves booking and CANCELLED intact', async () => {
    const { studio, tpl, token } = await seedStudioAdmin();
    const tomb = await createCancelledTombstone(studio.id, tpl.id);
    const member = await createUserWithPassword(prisma, {
      email: `tomb-mem-${Date.now()}@e2e.local`,
    });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    // Booking against cancelled class (historical) — still operational history.
    await createConfirmedBooking(prisma, studio.id, tomb.id, member.id);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/schedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: tpl.id,
        localStart: { date: DATE, time: TIME },
        localEnd: { date: DATE, time: '07:00' },
      })
      .expect(409);

    expect(String((res.body as { message?: unknown }).message ?? JSON.stringify(res.body))).toMatch(
      /cancelled class with bookings|SCHEDULE_SLOT_CANCELLED_WITH_HISTORY|history/i,
    );
    const code = (res.body as { code?: string }).code;
    if (code) {
      expect(code).toBe(SCHEDULE_SLOT_CANCELLED_WITH_HISTORY_CODE);
    }

    const after = await prisma.scheduledClass.findUniqueOrThrow({ where: { id: tomb.id } });
    expect(after.status).toBe(ClassStatus.CANCELLED);
    expect(await prisma.booking.count({ where: { scheduledClassId: tomb.id } })).toBe(1);
    expect(
      await prisma.scheduledClass.count({
        where: { studioId: studio.id, classTemplateId: tpl.id, startsAt: startsEnds().startsAt },
      }),
    ).toBe(1);
  });

  it('conflicts when CANCELLED slot has attendance', async () => {
    const { studio, tpl } = await seedStudioAdmin();
    const tomb = await createCancelledTombstone(studio.id, tpl.id);
    const member = await createUserWithPassword(prisma, {
      email: `tomb-att-${Date.now()}@e2e.local`,
    });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await prisma.attendance.create({
      data: {
        studioId: studio.id,
        scheduledClassId: tomb.id,
        userId: member.id,
        method: CheckInMethod.MANUAL,
        type: CheckInType.CLASS,
      },
    });

    await expect(
      scheduleService.createScheduledClass(studio.id, {
        templateId: tpl.id,
        localStart: { date: DATE, time: TIME },
        localEnd: { date: DATE, time: '07:00' },
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: SCHEDULE_SLOT_CANCELLED_WITH_HISTORY_CODE,
      }),
    });

    const after = await prisma.scheduledClass.findUniqueOrThrow({ where: { id: tomb.id } });
    expect(after.status).toBe(ClassStatus.CANCELLED);
    expect(await prisma.attendance.count({ where: { scheduledClassId: tomb.id } })).toBe(1);
  });

  it('conflicts when CANCELLED slot has a waiting waitlist entry', async () => {
    const { studio, tpl } = await seedStudioAdmin();
    const tomb = await createCancelledTombstone(studio.id, tpl.id);
    const member = await createUserWithPassword(prisma, {
      email: `tomb-wl-${Date.now()}@e2e.local`,
    });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    await prisma.waitlistEntry.create({
      data: {
        studioId: studio.id,
        scheduledClassId: tomb.id,
        userId: member.id,
        status: WaitlistStatus.WAITING,
        position: 1,
      },
    });

    await expect(
      scheduleService.createScheduledClass(studio.id, {
        templateId: tpl.id,
        localStart: { date: DATE, time: TIME },
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: SCHEDULE_SLOT_CANCELLED_WITH_HISTORY_CODE,
      }),
    });
  });

  it('keeps SCHEDULED duplicate conflict unchanged', async () => {
    const { studio, tpl } = await seedStudioAdmin();
    const { startsAt, endsAt } = startsEnds();
    await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt,
      endsAt,
      capacity: 10,
    });

    await expect(
      scheduleService.createScheduledClass(studio.id, {
        templateId: tpl.id,
        localStart: { date: DATE, time: TIME },
      }),
    ).rejects.toThrow(/already exists/i);

    expect(
      await prisma.scheduledClass.count({
        where: { studioId: studio.id, classTemplateId: tpl.id, startsAt },
      }),
    ).toBe(1);
  });

  it('creates normally when no existing row occupies the slot', async () => {
    const { studio, tpl } = await seedStudioAdmin();
    const created = await scheduleService.createScheduledClass(studio.id, {
      templateId: tpl.id,
      localStart: { date: DATE, time: TIME },
      localEnd: { date: DATE, time: '07:00' },
      capacity: 10,
    });
    expect(created.status).toBe(ClassStatus.SCHEDULED);
    expect(created.id).toBeTruthy();
  });

  it('allows a different ClassTemplate at the same startsAt', async () => {
    const { studio, tpl } = await seedStudioAdmin();
    const other = await createClassTemplate(prisma, studio.id, {
      name: 'Hyrox',
      defaultCapacity: 10,
      durationMinutes: 60,
    });
    await createCancelledTombstone(studio.id, tpl.id);

    const created = await scheduleService.createScheduledClass(studio.id, {
      templateId: other.id,
      localStart: { date: DATE, time: TIME },
      localEnd: { date: DATE, time: '07:00' },
    });
    expect(created.classTemplateId).toBe(other.id);
    expect(created.status).toBe(ClassStatus.SCHEDULED);
  });

  it('repeated create against an empty tombstone stays a single row', async () => {
    const { studio, tpl } = await seedStudioAdmin();
    const tomb = await createCancelledTombstone(studio.id, tpl.id);

    const first = await scheduleService.createScheduledClass(studio.id, {
      templateId: tpl.id,
      localStart: { date: DATE, time: TIME },
      capacity: 11,
    });
    expect(first.id).toBe(tomb.id);

    await expect(
      scheduleService.createScheduledClass(studio.id, {
        templateId: tpl.id,
        localStart: { date: DATE, time: TIME },
      }),
    ).rejects.toThrow(/already exists/i);

    expect(
      await prisma.scheduledClass.count({
        where: {
          studioId: studio.id,
          classTemplateId: tpl.id,
          startsAt: startsEnds().startsAt,
        },
      }),
    ).toBe(1);
  });

  it('reactivated row appears in listSchedule (SCHEDULED visibility)', async () => {
    const { studio, tpl } = await seedStudioAdmin();
    await createCancelledTombstone(studio.id, tpl.id);
    const reactivated = await scheduleService.createScheduledClass(studio.id, {
      templateId: tpl.id,
      localStart: { date: DATE, time: TIME },
    });

    const listed = await scheduleService.listSchedule(studio.id, {
      from: '2026-08-24T06:00:00.000Z',
      to: '2026-08-31T06:00:00.000Z',
    });
    expect(listed.some((c) => c.id === reactivated.id)).toBe(true);
  });
});
