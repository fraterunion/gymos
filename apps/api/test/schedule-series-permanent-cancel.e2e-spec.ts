import type { INestApplication } from '@nestjs/common';
import { BookingStatus, CancelSource, CheckInMethod, ClassStatus, Role, WaitlistStatus } from '@prisma/client';
import request from 'supertest';
import { ScheduleGeneratorService } from '../src/schedule-generator/schedule-generator.service';
import { ScheduleSeriesService } from '../src/schedule/schedule-series.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { getStudioLocalDateKey, studioLocalDateKeyToUtcAnchor } from '../src/common/date/studio-local-date';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createClassTemplate,
  createConfirmedBooking,
  createMembership,
  createStudio,
  createUserWithPassword,
} from './helpers/factories';

/**
 * PR #5 permanent series cancellation (POST :seriesId/cancel-preview and :seriesId/cancel):
 * future linked classes are cancelled with their bookings and waitlist, history and classes that
 * already started are preserved, the generator never recreates the series, and only OWNER/ADMIN
 * of the same studio can do it.
 */
describe('Schedule series permanent cancellation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seriesService: ScheduleSeriesService;
  let generator: ScheduleGeneratorService;

  const TZ = 'America/Mexico_City';
  const PASS = 'password12';
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    seriesService = app.get(ScheduleSeriesService);
    generator = app.get(ScheduleGeneratorService);
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
      password: PASS,
    });
    await createMembership(prisma, user.id, studioId, role);
    return user;
  }

  async function token(email: string) {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: PASS }).expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function linkedClass(studioId: string, classTemplateId: string, scheduleTemplateId: string, startsAt: Date, capacity = 5) {
    return prisma.scheduledClass.create({
      data: {
        studioId,
        classTemplateId,
        scheduleTemplateId,
        capacity,
        status: ClassStatus.SCHEDULED,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
      },
    });
  }

  async function counts(studioId: string) {
    const [classes, bookings, waitlist, attendances] = await Promise.all([
      prisma.scheduledClass.count({ where: { studioId } }),
      prisma.booking.count({ where: { studioId } }),
      prisma.waitlistEntry.count({ where: { studioId } }),
      prisma.attendance.count({ where: { studioId } }),
    ]);
    return { classes, bookings, waitlist, attendances };
  }

  async function fixture() {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id, { name: 'Serie QA' });
    const owner = await seedUser(studio.id, Role.OWNER, 'owner');
    const members = await Promise.all([1, 2, 3, 4].map((n) => seedUser(studio.id, Role.MEMBER, `m${n}`)));
    await seriesService.createRecurringSeries(
      studio.id,
      { classTemplateId: tpl.id, daysOfWeek: [4], startTime: '07:15', intervalWeeks: 1, startsOn: '2026-08-20', endsOn: null, capacity: 12, confirmWarnings: true },
      owner.id,
    );
    const series = await prisma.scheduleTemplate.findFirstOrThrow({ where: { studioId: studio.id } });
    // Odd minute offsets keep these off the generated 07:15 slots (unique studio/template/start).
    const now = Date.now();
    const past = await linkedClass(studio.id, tpl.id, series.id, new Date(now - 2 * DAY - 7 * 60_000));
    const started = await linkedClass(studio.id, tpl.id, series.id, new Date(now - 10 * 60_000));
    const futureA = await linkedClass(studio.id, tpl.id, series.id, new Date(now + 2 * DAY + 11 * 60_000), 1);
    const futureB = await linkedClass(studio.id, tpl.id, series.id, new Date(now + 9 * DAY + 13 * 60_000), 1);
    const [m1, m2, m3, m4] = members;
    const pastBooking = await createConfirmedBooking(prisma, studio.id, past.id, m1!.id);
    const pastAttendance = await prisma.attendance.create({
      data: { studioId: studio.id, scheduledClassId: past.id, userId: m1!.id, method: CheckInMethod.MANUAL, checkedInAt: past.startsAt },
    });
    const startedBooking = await createConfirmedBooking(prisma, studio.id, started.id, m2!.id);
    const bookingA = await createConfirmedBooking(prisma, studio.id, futureA.id, m3!.id);
    const bookingB = await createConfirmedBooking(prisma, studio.id, futureB.id, m1!.id);
    const waitB = await prisma.waitlistEntry.create({
      data: { studioId: studio.id, scheduledClassId: futureB.id, userId: m4!.id, status: WaitlistStatus.WAITING, position: 1 },
    });
    return { studio, tpl, owner, series, past, started, futureA, futureB, pastBooking, pastAttendance, startedBooking, bookingA, bookingB, waitB };
  }

  const base = (studioId: string, seriesId: string) => `/api/v1/studios/${studioId}/schedule-series/${seriesId}`;

  it('is OWNER/ADMIN-only and scoped to the studio', async () => {
    const f = await fixture();
    const frontDesk = await seedUser(f.studio.id, Role.FRONT_DESK, 'desk');
    const staff = await seedUser(f.studio.id, Role.STAFF, 'staff');
    const other = await createStudio(prisma, { timezone: TZ });
    const otherOwner = await seedUser(other.id, Role.OWNER, 'other-owner');

    for (const user of [frontDesk, staff]) {
      const t = await token(user.email);
      await request(app.getHttpServer()).post(`${base(f.studio.id, f.series.id)}/cancel-preview`).set('Authorization', `Bearer ${t}`).expect(403);
      await request(app.getHttpServer()).post(`${base(f.studio.id, f.series.id)}/cancel`).set('Authorization', `Bearer ${t}`).send({ confirmReservations: true }).expect(403);
    }
    const otherToken = await token(otherOwner.email);
    // Not a member of this studio.
    await request(app.getHttpServer()).post(`${base(f.studio.id, f.series.id)}/cancel`).set('Authorization', `Bearer ${otherToken}`).send({ confirmReservations: true }).expect(403);
    // Own studio, foreign series id.
    await request(app.getHttpServer()).post(`${base(other.id, f.series.id)}/cancel`).set('Authorization', `Bearer ${otherToken}`).send({ confirmReservations: true }).expect(404);

    expect((await prisma.scheduleTemplate.findUniqueOrThrow({ where: { id: f.series.id } })).active).toBe(true);
    expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id: f.futureA.id } })).status).toBe(ClassStatus.SCHEDULED);
  });

  it('previews, requires confirmation, then cancels only future classes and preserves history', async () => {
    const f = await fixture();
    const ownerToken = await token(f.owner.email);
    const before = await counts(f.studio.id);

    const preview = await request(app.getHttpServer())
      .post(`${base(f.studio.id, f.series.id)}/cancel-preview`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(preview.body.totalReservations).toBe(2);
    expect(preview.body.classesWithReservations).toBe(2);
    expect(preview.body.affectedClassCount).toBeGreaterThanOrEqual(2);

    const refused = await request(app.getHttpServer())
      .post(`${base(f.studio.id, f.series.id)}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({})
      .expect(400);
    expect(refused.body.requiresConfirmation).toBe(true);
    expect((await prisma.scheduleTemplate.findUniqueOrThrow({ where: { id: f.series.id } })).active).toBe(true);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: f.bookingA.id } })).status).toBe(BookingStatus.CONFIRMED);

    const done = await request(app.getHttpServer())
      .post(`${base(f.studio.id, f.series.id)}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ confirmReservations: true, cancelReason: 'QA permanente' })
      .expect(200);
    expect(done.body.alreadyEnded).toBe(false);
    expect(done.body.cancelledCount).toBe(preview.body.affectedClassCount);

    // Series stops generating.
    expect((await prisma.scheduleTemplate.findUniqueOrThrow({ where: { id: f.series.id } })).active).toBe(false);

    // Future: classes cancelled, bookings cancelled by the studio, waitlist expired, nobody promoted.
    for (const id of [f.futureA.id, f.futureB.id]) {
      const row = await prisma.scheduledClass.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe(ClassStatus.CANCELLED);
      expect(row.scheduleTemplateId).toBe(f.series.id);
    }
    for (const id of [f.bookingA.id, f.bookingB.id]) {
      const b = await prisma.booking.findUniqueOrThrow({ where: { id } });
      expect(b.status).toBe(BookingStatus.CANCELLED);
      expect(b.cancelSource).toBe(CancelSource.STUDIO);
      expect(b.cancelledAt).not.toBeNull();
    }
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: f.waitB.id } })).status).toBe(WaitlistStatus.EXPIRED);
    expect(await prisma.scheduledClass.count({
      where: { scheduleTemplateId: f.series.id, startsAt: { gte: new Date() }, status: ClassStatus.SCHEDULED },
    })).toBe(0);

    // History and the class already in progress are untouched.
    for (const [cls, booking] of [[f.past, f.pastBooking], [f.started, f.startedBooking]] as const) {
      const row = await prisma.scheduledClass.findUniqueOrThrow({ where: { id: cls.id } });
      expect(row.status).toBe(ClassStatus.SCHEDULED);
      expect(row.updatedAt.getTime()).toBe(cls.updatedAt.getTime());
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(BookingStatus.CONFIRMED);
    }
    expect(await prisma.attendance.findUnique({ where: { id: f.pastAttendance.id } })).not.toBeNull();

    // Integrity: nothing confirmed or waiting on a cancelled class; no row deleted.
    expect(await prisma.booking.count({
      where: { studioId: f.studio.id, status: BookingStatus.CONFIRMED, scheduledClass: { status: ClassStatus.CANCELLED } },
    })).toBe(0);
    expect(await prisma.waitlistEntry.count({
      where: { studioId: f.studio.id, status: WaitlistStatus.WAITING, scheduledClass: { status: ClassStatus.CANCELLED } },
    })).toBe(0);
    expect(await counts(f.studio.id)).toEqual(before);

    const audit = await prisma.auditLog.findMany({ where: { studioId: f.studio.id, action: 'SCHEDULE_ENTIRE_SERIES_CANCELLED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorUserId).toBe(f.owner.id);

    // The generator never recreates the cancelled series.
    const linkedBefore = await prisma.scheduledClass.count({ where: { scheduleTemplateId: f.series.id } });
    const todayKey = getStudioLocalDateKey(new Date(), TZ);
    await generator.generateRange(
      f.studio.id,
      studioLocalDateKeyToUtcAnchor(todayKey, TZ),
      new Date(studioLocalDateKeyToUtcAnchor(todayKey, TZ).getTime() + 120 * DAY),
      { isDryRun: false, triggeredBy: 'MANUAL' },
    );
    expect(await prisma.scheduledClass.count({ where: { scheduleTemplateId: f.series.id } })).toBe(linkedBefore);

    // A retry changes no class, booking or waitlist row.
    const retry = await request(app.getHttpServer())
      .post(`${base(f.studio.id, f.series.id)}/cancel`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ confirmReservations: true })
      .expect(200);
    expect(retry.body).toEqual({ cancelledCount: 0, alreadyEnded: true, skippedProtectedCount: 0 });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: f.startedBooking.id } })).status).toBe(BookingStatus.CONFIRMED);
    expect(await counts(f.studio.id)).toEqual(before);
  });
});
