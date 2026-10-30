import type { INestApplication } from '@nestjs/common';
import { BookingStatus, CheckInMethod, ClassStatus, Role, WaitlistStatus } from '@prisma/client';
import request from 'supertest';
import { BulkScheduleOperation } from '../src/schedule/dto/schedule-operations.dto';
import { ScheduleOperationsService } from '../src/schedule/schedule-operations.service';
import { ScheduleSeriesService } from '../src/schedule/schedule-series.service';
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

/**
 * Cancellation safety policy (2026-10-30):
 *   - past, in-progress and COMPLETED classes cannot be cancelled;
 *   - a future class with attendance (early check-in) cannot be cancelled directly — the reason is
 *     returned — and series cancellations keep it and report it as skipped;
 *   - attendance is never deleted or rewritten; bookings/waitlist of protected classes stay;
 *   - future classes without attendance cancel exactly as before; retries are idempotent.
 */
describe('Class cancellation protection (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seriesService: ScheduleSeriesService;
  let ops: ScheduleOperationsService;

  const TZ = 'America/Mexico_City';
  const PASS = 'password12';
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    seriesService = app.get(ScheduleSeriesService);
    ops = app.get(ScheduleOperationsService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedUser(studioId: string, role: Role, label: string) {
    const user = await createUserWithPassword(prisma, { email: `${label}-${Date.now()}-${Math.random()}@e2e.local`, password: PASS });
    await createMembership(prisma, user.id, studioId, role);
    return user;
  }

  async function token(email: string) {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: PASS }).expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  type Snapshot = { status: ClassStatus; updatedAt: number; bookings: string[]; waitlist: string[]; attendances: number };

  /** Class row, its bookings and waitlist statuses, and attendance count. */
  async function snapshot(classId: string): Promise<Snapshot> {
    const cls = await prisma.scheduledClass.findUniqueOrThrow({ where: { id: classId } });
    const bookings = await prisma.booking.findMany({ where: { scheduledClassId: classId }, orderBy: { id: 'asc' } });
    const waitlist = await prisma.waitlistEntry.findMany({ where: { scheduledClassId: classId }, orderBy: { id: 'asc' } });
    return {
      status: cls.status,
      updatedAt: cls.updatedAt.getTime(),
      bookings: bookings.map((b) => b.status),
      waitlist: waitlist.map((w) => w.status),
      attendances: await prisma.attendance.count({ where: { scheduledClassId: classId } }),
    };
  }

  async function integrity(studioId: string) {
    expect(await prisma.booking.count({
      where: { studioId, status: BookingStatus.CONFIRMED, scheduledClass: { status: ClassStatus.CANCELLED } },
    })).toBe(0);
    expect(await prisma.waitlistEntry.count({
      where: { studioId, status: WaitlistStatus.WAITING, scheduledClass: { status: ClassStatus.CANCELLED } },
    })).toBe(0);
  }

  async function fixture() {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const owner = await seedUser(studio.id, Role.OWNER, 'owner');
    const members = await Promise.all([1, 2, 3, 4, 5].map((n) => seedUser(studio.id, Role.MEMBER, `m${n}`)));
    await seriesService.createRecurringSeries(
      studio.id,
      { classTemplateId: tpl.id, daysOfWeek: [4], startTime: '07:15', intervalWeeks: 1, startsOn: '2026-08-20', endsOn: null, capacity: 12, confirmWarnings: true },
      owner.id,
    );
    const series = await prisma.scheduleTemplate.findFirstOrThrow({ where: { studioId: studio.id } });
    const linked = (startsAt: Date, status: ClassStatus = ClassStatus.SCHEDULED) => prisma.scheduledClass.create({
      data: { studioId: studio.id, classTemplateId: tpl.id, scheduleTemplateId: series.id, capacity: 1, status, startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) },
    });
    const attend = (classId: string, userId: string, at: Date) =>
      prisma.attendance.create({ data: { studioId: studio.id, scheduledClassId: classId, userId, method: CheckInMethod.MANUAL, checkedInAt: at } });
    const wait = (classId: string, userId: string) =>
      prisma.waitlistEntry.create({ data: { studioId: studio.id, scheduledClassId: classId, userId, status: WaitlistStatus.WAITING, position: 1 } });
    const [m1, m2, m3, m4, m5] = members as [typeof members[0], typeof members[0], typeof members[0], typeof members[0], typeof members[0]];
    const now = Date.now();
    // Odd minute offsets keep these off the generated 07:15 slots (unique studio/template/start).
    const past = await linked(new Date(now - 2 * DAY - 7 * MIN));
    await createConfirmedBooking(prisma, studio.id, past.id, m1.id);
    await attend(past.id, m1.id, past.startsAt);
    const inProgress = await linked(new Date(now - 10 * MIN));
    await createConfirmedBooking(prisma, studio.id, inProgress.id, m2.id);
    const completed = await linked(new Date(now - 3 * DAY - 13 * MIN), ClassStatus.COMPLETED);
    // Future, early check-in recorded, plus a waitlisted member.
    const checkedIn = await linked(new Date(now + 1 * DAY + 11 * MIN));
    await createConfirmedBooking(prisma, studio.id, checkedIn.id, m3.id);
    await attend(checkedIn.id, m3.id, new Date(now));
    await wait(checkedIn.id, m4.id);
    // Future, no attendance, with a booking and a waitlisted member.
    const futureA = await linked(new Date(now + 2 * DAY + 17 * MIN));
    await createConfirmedBooking(prisma, studio.id, futureA.id, m4.id);
    await wait(futureA.id, m5.id);
    const futureB = await linked(new Date(now + 9 * DAY + 19 * MIN));
    await createConfirmedBooking(prisma, studio.id, futureB.id, m5.id);
    return { studio, tpl, owner, series, past, inProgress, completed, checkedIn, futureA, futureB, ownerToken: await token(owner.email) };
  }

  const occurrenceUrl = (studioId: string, classId: string) => `/api/v1/studios/${studioId}/schedule-series/occurrences/${classId}`;
  const oneOffUrl = (studioId: string, classId: string) => `/api/v1/studios/${studioId}/schedule/${classId}`;

  it('direct cancellation is refused with the reason for started, completed and early-checked-in classes', async () => {
    const f = await fixture();
    const cases = [
      [f.past, 'ya comenzó'],
      [f.inProgress, 'ya comenzó'],
      [f.completed, 'ya comenzó'],
      [f.checkedIn, 'asistencias registradas'],
    ] as const;
    for (const [cls, reason] of cases) {
      const before = await snapshot(cls.id);
      const preview = await request(app.getHttpServer())
        .post(`${occurrenceUrl(f.studio.id, cls.id)}/cancel-preview`)
        .set('Authorization', `Bearer ${f.ownerToken}`)
        .send({ scope: 'SINGLE' })
        .expect(400);
      expect(preview.body.message).toContain(reason);
      await request(app.getHttpServer())
        .delete(occurrenceUrl(f.studio.id, cls.id))
        .set('Authorization', `Bearer ${f.ownerToken}`)
        .send({ scope: 'SINGLE', confirmReservations: true })
        .expect(400);
      const oneOff = await request(app.getHttpServer())
        .delete(oneOffUrl(f.studio.id, cls.id))
        .set('Authorization', `Bearer ${f.ownerToken}`)
        .expect(400);
      expect(oneOff.body.message).toContain(reason);
      // PATCH status → CANCELLED is the same direct cancellation.
      await request(app.getHttpServer())
        .patch(oneOffUrl(f.studio.id, cls.id))
        .set('Authorization', `Bearer ${f.ownerToken}`)
        .send({ status: 'CANCELLED' })
        .expect(400);
      expect(await snapshot(cls.id)).toEqual(before);
    }
    // "Esta y las siguientes" may not start from a class that already started.
    await request(app.getHttpServer())
      .delete(occurrenceUrl(f.studio.id, f.past.id))
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ scope: 'FOLLOWING', confirmReservations: true })
      .expect(400);
    const series = await prisma.scheduleTemplate.findUniqueOrThrow({ where: { id: f.series.id } });
    expect(series.active).toBe(true);
    expect(series.endsAt).toEqual(f.series.endsAt);
  });

  it('a future class without attendance cancels as before, and retrying is a no-op', async () => {
    const f = await fixture();
    await request(app.getHttpServer())
      .delete(occurrenceUrl(f.studio.id, f.futureA.id))
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ scope: 'SINGLE', confirmReservations: true })
      .expect(200);
    const after = await snapshot(f.futureA.id);
    expect(after.status).toBe(ClassStatus.CANCELLED);
    expect(after.bookings).toEqual([BookingStatus.CANCELLED]);
    expect(after.waitlist).toEqual([WaitlistStatus.EXPIRED]);
    // Retry of the one-off cancel on an already-cancelled class changes nothing.
    await request(app.getHttpServer()).delete(oneOffUrl(f.studio.id, f.futureA.id)).set('Authorization', `Bearer ${f.ownerToken}`).expect(204);
    expect(await snapshot(f.futureA.id)).toEqual(after);
    await integrity(f.studio.id);
  });

  it.each(['FOLLOWING', 'SERIES'] as const)('%s cancellation keeps the early-checked-in occurrence and reports it as skipped', async (scope) => {
    const f = await fixture();
    const kept = await snapshot(f.checkedIn.id);
    const history = await Promise.all([f.past, f.inProgress, f.completed].map((c) => snapshot(c.id)));
    const attendancesBefore = await prisma.attendance.count({ where: { studioId: f.studio.id } });

    // The boundary for FOLLOWING is the attended class itself: it is kept, the rest are cancelled.
    const boundary = f.checkedIn;
    const preview = await request(app.getHttpServer())
      .post(`${occurrenceUrl(f.studio.id, boundary.id)}/cancel-preview`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ scope })
      .expect(201);
    expect(preview.body.protectedClassCount).toBe(1);

    const res = await request(app.getHttpServer())
      .delete(occurrenceUrl(f.studio.id, boundary.id))
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ scope, confirmReservations: true })
      .expect(200);
    expect(res.body.skippedProtectedCount).toBe(1);
    expect(res.body.cancelledCount).toBe(preview.body.affectedClassCount);

    expect(await snapshot(f.checkedIn.id)).toEqual(kept);
    for (const id of [f.futureA.id, f.futureB.id]) {
      const row = await snapshot(id);
      expect(row.status).toBe(ClassStatus.CANCELLED);
      expect(row.bookings.every((s) => s === BookingStatus.CANCELLED)).toBe(true);
      expect(row.waitlist.every((s) => s === WaitlistStatus.EXPIRED)).toBe(true);
    }
    expect(await Promise.all([f.past, f.inProgress, f.completed].map((c) => snapshot(c.id)))).toEqual(history);
    expect(await prisma.attendance.count({ where: { studioId: f.studio.id } })).toBe(attendancesBefore);
    await integrity(f.studio.id);

    const action = scope === 'FOLLOWING' ? 'SCHEDULE_FUTURE_SERIES_CANCELLED' : 'SCHEDULE_ENTIRE_SERIES_CANCELLED';
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { studioId: f.studio.id, action } });
    expect((audit.metadata as { skippedProtectedCount: number }).skippedProtectedCount).toBe(1);
  });

  it('permanent series cancellation keeps protected occurrences, reports them, and retries idempotently', async () => {
    const f = await fixture();
    const kept = await snapshot(f.checkedIn.id);
    const base = `/api/v1/studios/${f.studio.id}/schedule-series/${f.series.id}`;
    const preview = await request(app.getHttpServer()).post(`${base}/cancel-preview`).set('Authorization', `Bearer ${f.ownerToken}`).expect(200);
    expect(preview.body.protectedClassCount).toBe(1);
    const done = await request(app.getHttpServer())
      .post(`${base}/cancel`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ confirmReservations: true })
      .expect(200);
    expect(done.body).toEqual({ cancelledCount: preview.body.affectedClassCount, alreadyEnded: false, skippedProtectedCount: 1 });
    expect(await snapshot(f.checkedIn.id)).toEqual(kept);
    const afterFirst = await Promise.all([f.futureA, f.futureB, f.checkedIn].map((c) => snapshot(c.id)));

    const retry = await request(app.getHttpServer())
      .post(`${base}/cancel`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ confirmReservations: true })
      .expect(200);
    expect(retry.body).toEqual({ cancelledCount: 0, alreadyEnded: true, skippedProtectedCount: 1 });
    expect(await Promise.all([f.futureA, f.futureB, f.checkedIn].map((c) => snapshot(c.id)))).toEqual(afterFirst);
    await integrity(f.studio.id);
  });

  it('finish series keeps an early-checked-in occurrence after the boundary', async () => {
    const f = await fixture();
    const kept = await snapshot(f.checkedIn.id);
    const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    const result = await seriesService.finishSeries(
      f.studio.id,
      f.series.id,
      { mode: 'ON_DATE', boundaryDate: todayKey, confirmReservations: true },
      f.owner.id,
    );
    expect(result.skippedProtectedCount).toBe(1);
    expect(await snapshot(f.checkedIn.id)).toEqual(kept);
    expect((await snapshot(f.futureA.id)).status).toBe(ClassStatus.CANCELLED);
    await integrity(f.studio.id);
  });

  it('bulk cancel refuses a selection that includes a protected class, and cancels a clean one', async () => {
    const f = await fixture();
    const before = await Promise.all([f.checkedIn, f.futureA].map((c) => snapshot(c.id)));
    await expect(ops.executeBulk(
      f.studio.id,
      { scheduledClassIds: [f.checkedIn.id, f.futureA.id], operation: BulkScheduleOperation.CANCEL, confirmWarnings: true, confirmReservations: true },
      f.owner.id,
    )).rejects.toMatchObject({ response: { conflicts: [expect.objectContaining({ kind: 'PROTECTED_CLASS', scheduledClassId: f.checkedIn.id })] } });
    expect(await Promise.all([f.checkedIn, f.futureA].map((c) => snapshot(c.id)))).toEqual(before);

    const oneOff = await createScheduledClass(prisma, f.studio.id, f.tpl.id, {
      startsAt: new Date(Date.now() + 4 * DAY + 23 * MIN),
      endsAt: new Date(Date.now() + 4 * DAY + 83 * MIN),
    });
    await ops.executeBulk(
      f.studio.id,
      { scheduledClassIds: [f.futureA.id, oneOff.id], operation: BulkScheduleOperation.CANCEL, confirmWarnings: true, confirmReservations: true },
      f.owner.id,
    );
    expect((await snapshot(f.futureA.id)).status).toBe(ClassStatus.CANCELLED);
    expect((await snapshot(oneOff.id)).status).toBe(ClassStatus.CANCELLED);
    await integrity(f.studio.id);
  });
});
