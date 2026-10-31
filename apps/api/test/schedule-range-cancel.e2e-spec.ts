import type { INestApplication } from '@nestjs/common';
import { BookingStatus, CancelSource, CheckInMethod, ClassStatus, Role, WaitlistStatus } from '@prisma/client';
import request from 'supertest';
import { addDaysToDateKey, getStudioLocalDateKey, studioLocalTimeToUtc } from '../src/common/date/studio-local-date';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScheduleGeneratorService } from '../src/schedule-generator/schedule-generator.service';
import { RANGE_CANCEL_AUDIT_ACTION, studioLocalRangeToUtc } from '../src/schedule/schedule-range-cancellation.service';
import { ScheduleSeriesService } from '../src/schedule/schedule-series.service';
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
 * "Cancelar clases por rango de fechas" (2026-10-30): one operation cancels SCHEDULED classes
 * between two studio-local dates across many weeks, optionally narrowed by instructor / class
 * type, from an exact preview; protected classes (started, completed, early check-in) are kept
 * and reported; cancelled rows are never deleted and never regenerated.
 */
describe('Schedule range cancellation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seriesService: ScheduleSeriesService;
  let generator: ScheduleGeneratorService;

  const TZ = 'America/Mexico_City';
  const PASS = 'password12';
  const MIN = 60_000;
  const today = () => getStudioLocalDateKey(new Date(), TZ);
  const D = (n: number) => addDaysToDateKey(today(), n);
  const at = (dateKey: string, hhmm: string) => studioLocalTimeToUtc(dateKey, hhmm, TZ);

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

  const api = () => request(app.getHttpServer());

  async function seedUser(studioId: string, role: Role, label: string) {
    const user = await createUserWithPassword(prisma, { email: `${label}-${Date.now()}-${Math.random()}@e2e.local`, password: PASS });
    await createMembership(prisma, user.id, studioId, role);
    return user;
  }

  async function token(email: string) {
    const res = await api().post('/api/v1/auth/login').send({ email, password: PASS }).expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function fixture() {
    const studio = await createStudio(prisma, { timezone: TZ });
    const other = await createStudio(prisma, { timezone: TZ });
    const yoga = await createClassTemplate(prisma, studio.id, { name: 'Yoga' });
    const hiit = await createClassTemplate(prisma, studio.id, { name: 'HIIT' });
    const otherTpl = await createClassTemplate(prisma, other.id, { name: 'Yoga' });
    const owner = await seedUser(studio.id, Role.OWNER, 'owner');
    const otherOwner = await seedUser(other.id, Role.OWNER, 'other-owner');
    const i1 = await seedUser(studio.id, Role.INSTRUCTOR, 'i1');
    const i2 = await seedUser(studio.id, Role.INSTRUCTOR, 'i2');
    const members = await Promise.all([1, 2, 3, 4].map((n) => seedUser(studio.id, Role.MEMBER, `m${n}`)));
    const [m1, m2, m3, m4] = members as [typeof members[0], typeof members[0], typeof members[0], typeof members[0]];

    // Recurring: Yoga Mon + Wed 07:00 with instructor i1, materialized by the real series service.
    await seriesService.createRecurringSeries(
      studio.id,
      { classTemplateId: yoga.id, instructorId: i1.id, daysOfWeek: [1, 3], startTime: '07:00', intervalWeeks: 1, startsOn: D(0), endsOn: null, capacity: 12, confirmWarnings: true },
      owner.id,
    );
    // One schedule template per weekday of the series.
    const series = await prisma.scheduleTemplate.findFirstOrThrow({ where: { studioId: studio.id } });
    expect(await prisma.scheduleTemplate.count({ where: { studioId: studio.id } })).toBe(2);

    const oneOff = (startsAt: Date, opts: { status?: ClassStatus; templateId?: string; studioId?: string; instructorId?: string | null } = {}) =>
      prisma.scheduledClass.create({
        data: {
          studioId: opts.studioId ?? studio.id,
          classTemplateId: opts.templateId ?? hiit.id,
          instructorId: opts.instructorId === undefined ? i2.id : opts.instructorId,
          capacity: 2,
          status: opts.status ?? ClassStatus.SCHEDULED,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 60 * MIN),
        },
      });
    const wait = (classId: string, userId: string) =>
      prisma.waitlistEntry.create({ data: { studioId: studio.id, scheduledClassId: classId, userId, status: WaitlistStatus.WAITING, position: 1 } });

    const fromDate = D(14);
    const toDate = D(34);
    // Timezone boundaries: local midnight edges of the inclusive range.
    const firstMinute = await oneOff(at(fromDate, '00:15'));
    const beforeRange = await oneOff(at(D(13), '23:45'));
    const lastLocal = await oneOff(at(toDate, '23:30'));
    const afterRange = await oneOff(at(D(35), '00:15'));
    // One-offs with bookings and waitlist, in different weeks.
    const hiitWeek1 = await oneOff(at(D(15), '18:00'));
    await createConfirmedBooking(prisma, studio.id, hiitWeek1.id, m1.id);
    await createConfirmedBooking(prisma, studio.id, hiitWeek1.id, m2.id);
    await wait(hiitWeek1.id, m3.id);
    const hiitWeek3 = await oneOff(at(D(29), '18:00'));
    await createConfirmedBooking(prisma, studio.id, hiitWeek3.id, m4.id);
    // Future class with an early check-in: protected, kept and reported.
    const checkedIn = await oneOff(at(D(20), '19:00'));
    await createConfirmedBooking(prisma, studio.id, checkedIn.id, m3.id);
    await prisma.attendance.create({ data: { studioId: studio.id, scheduledClassId: checkedIn.id, userId: m3.id, method: CheckInMethod.MANUAL, checkedInAt: new Date() } });
    await wait(checkedIn.id, m4.id);
    // Already cancelled in range; other studio in range.
    await oneOff(at(D(16), '09:00'), { status: ClassStatus.CANCELLED });
    const otherStudioClass = await oneOff(at(D(17), '09:00'), { studioId: other.id, templateId: otherTpl.id, instructorId: null });

    // The daily generator materializes recurring occurrences ahead, as in production.
    const range = studioLocalRangeToUtc(fromDate, toDate, TZ);
    await generator.generateRange(studio.id, new Date(), new Date(range.end.getTime() + 24 * 60 * MIN), { isDryRun: false, triggeredBy: 'MANUAL' });
    // A booking on a recurring occurrence in range.
    const yogaInRange = await prisma.scheduledClass.findMany({
      where: { studioId: studio.id, classTemplateId: yoga.id, scheduleTemplateId: { not: null }, startsAt: { gte: range.start, lt: range.end } },
      orderBy: { startsAt: 'asc' },
    });
    expect(yogaInRange.length).toBeGreaterThanOrEqual(6);
    await createConfirmedBooking(prisma, studio.id, yogaInRange[0]!.id, m4.id);

    return {
      studio, other, yoga, hiit, otherTpl, owner, i1, i2, series, members, range, fromDate, toDate,
      firstMinute, beforeRange, lastLocal, afterRange, hiitWeek1, hiitWeek3, checkedIn, otherStudioClass, yogaInRange,
      ownerToken: await token(owner.email), otherOwnerToken: await token(otherOwner.email),
      base: `/api/v1/studios/${studio.id}/schedule-operations/range-cancel`,
    };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const preview = (f: Fixture, body: Record<string, unknown> = {}, expectStatus = 200) =>
    api().post(`${f.base}/preview`).set('Authorization', `Bearer ${f.ownerToken}`).send({ fromDate: f.fromDate, toDate: f.toDate, ...body }).expect(expectStatus);
  const execute = (f: Fixture, body: Record<string, unknown>, expectStatus = 200) =>
    api().post(f.base).set('Authorization', `Bearer ${f.ownerToken}`).send({ fromDate: f.fromDate, toDate: f.toDate, confirm: true, ...body }).expect(expectStatus);

  it('previews every class of the range across weeks with bookings, waitlist, protected and boundaries', async () => {
    const f = await fixture();
    const res = await preview(f);
    const ids = (res.body.classes as Array<{ id: string }>).map((c) => c.id).sort();
    const expected = [f.firstMinute.id, f.lastLocal.id, f.hiitWeek1.id, f.hiitWeek3.id, ...f.yogaInRange.map((c) => c.id)].sort();
    expect(ids).toEqual(expected);
    expect(res.body.weekCount).toBeGreaterThanOrEqual(3);
    expect(res.body.totals).toEqual({ classes: expected.length, bookings: 4, waitlist: 1, protected: 1 });
    expect(res.body.alreadyCancelledCount).toBe(1);
    expect(res.body.protectedClasses).toEqual([
      expect.objectContaining({ id: f.checkedIn.id, reason: 'ATTENDED', attendances: 1, bookings: 1, waitlist: 1, className: 'HIIT' }),
    ]);
    const week1 = (res.body.classes as Array<Record<string, unknown>>).find((c) => c['id'] === f.hiitWeek1.id);
    expect(week1).toMatchObject({ bookings: 2, waitlist: 1, localDate: D(15), localTime: '18:00', className: 'HIIT', seriesId: null });
    const recurring = (res.body.classes as Array<Record<string, unknown>>).find((c) => c['id'] === f.yogaInRange[0]!.id);
    expect(recurring).toMatchObject({ seriesId: f.yogaInRange[0]!.scheduleTemplateId, className: 'Yoga', localTime: '07:00', bookings: 1 });
    expect(recurring!['seriesId']).not.toBeNull();
    expect(ids).not.toContain(f.beforeRange.id);
    expect(ids).not.toContain(f.afterRange.id);
    expect(ids).not.toContain(f.otherStudioClass.id);
    expect(res.body.previewFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('filters by class type and by instructor using the studio entities', async () => {
    const f = await fixture();
    const hiitOnly = await preview(f, { classTemplateIds: [f.hiit.id] });
    expect((hiitOnly.body.classes as Array<{ className: string }>).every((c) => c.className === 'HIIT')).toBe(true);
    expect(hiitOnly.body.totals.classes).toBe(4);
    const i1Only = await preview(f, { instructorIds: [f.i1.id] });
    expect(i1Only.body.totals.classes).toBe(f.yogaInRange.length);
    expect(i1Only.body.protectedClasses).toEqual([]);
    const none = await preview(f, { classTemplateIds: [f.yoga.id], instructorIds: [f.i2.id] });
    expect(none.body.totals.classes).toBe(0);
    await preview(f, { classTemplateIds: [f.otherTpl.id] }, 400);
  });

  it('cancels exactly the previewed classes in one step, cascades reservations, keeps protected and history', async () => {
    const f = await fixture();
    const before = await prisma.scheduledClass.count();
    const p = await preview(f);
    const res = await execute(f, { previewFingerprint: p.body.previewFingerprint, cancelReason: 'Remodelación del estudio', idempotencyKey: 'range-cancel-e2e-001' });
    expect(res.body).toMatchObject({ cancelledCount: p.body.totals.classes, cancelledBookingCount: 4, expiredWaitlistCount: 1 });
    expect(res.body.protectedClasses).toHaveLength(1);
    expect([...res.body.cancelledClassIds].sort()).toEqual((p.body.classes as Array<{ id: string }>).map((c) => c.id).sort());

    for (const id of res.body.cancelledClassIds as string[]) {
      const cls = await prisma.scheduledClass.findUniqueOrThrow({ where: { id } });
      expect(cls).toMatchObject({ status: ClassStatus.CANCELLED, cancelReason: 'Remodelación del estudio' });
    }
    const cancelledBookings = await prisma.booking.findMany({ where: { scheduledClassId: { in: res.body.cancelledClassIds } } });
    expect(cancelledBookings.every((b) => b.status === BookingStatus.CANCELLED && b.cancelSource === CancelSource.STUDIO)).toBe(true);
    expect(await prisma.waitlistEntry.count({ where: { scheduledClassId: f.hiitWeek1.id, status: WaitlistStatus.EXPIRED } })).toBe(1);
    // Protected class untouched: still scheduled, booking + waitlist + attendance intact.
    expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id: f.checkedIn.id } })).status).toBe(ClassStatus.SCHEDULED);
    expect(await prisma.booking.count({ where: { scheduledClassId: f.checkedIn.id, status: BookingStatus.CONFIRMED } })).toBe(1);
    expect(await prisma.waitlistEntry.count({ where: { scheduledClassId: f.checkedIn.id, status: WaitlistStatus.WAITING } })).toBe(1);
    expect(await prisma.attendance.count({ where: { scheduledClassId: f.checkedIn.id } })).toBe(1);
    // Outside the range or another studio: untouched. Nothing deleted.
    for (const cls of [f.beforeRange, f.afterRange, f.otherStudioClass]) {
      expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id: cls.id } })).status).toBe(ClassStatus.SCHEDULED);
    }
    expect(await prisma.scheduledClass.count()).toBe(before);
    const audit = await prisma.auditLog.findMany({ where: { studioId: f.studio.id, action: RANGE_CANCEL_AUDIT_ACTION } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorUserId).toBe(f.owner.id);
    expect(audit[0]!.metadata).toMatchObject({ fromDate: f.fromDate, toDate: f.toDate, cancelReason: 'Remodelación del estudio', cancelledCount: p.body.totals.classes, protectedCount: 1 });
  });

  it('the recurring generator cannot recreate cancelled occurrences, and other dates keep generating', async () => {
    const f = await fixture();
    const p = await preview(f, { classTemplateIds: [f.yoga.id] });
    await execute(f, { classTemplateIds: [f.yoga.id], previewFingerprint: p.body.previewFingerprint, idempotencyKey: 'range-cancel-e2e-regen' });
    const horizonEnd = new Date(f.range.end.getTime() + 21 * 24 * 60 * MIN);
    await generator.generateRange(f.studio.id, new Date(), horizonEnd, { isDryRun: false, triggeredBy: 'MANUAL' });

    const inRange = await prisma.scheduledClass.findMany({
      where: { studioId: f.studio.id, classTemplateId: f.yoga.id, startsAt: { gte: f.range.start, lt: f.range.end } },
    });
    expect(inRange).toHaveLength(f.yogaInRange.length);
    expect(inRange.every((c) => c.status === ClassStatus.CANCELLED)).toBe(true);
    // Series behaviour outside the range is preserved.
    expect(await prisma.scheduledClass.count({
      where: { studioId: f.studio.id, classTemplateId: f.yoga.id, scheduleTemplateId: { not: null }, status: ClassStatus.SCHEDULED, startsAt: { gte: f.range.end } },
    })).toBeGreaterThan(0);
    expect((await prisma.scheduleTemplate.findUniqueOrThrow({ where: { id: f.series.id } })).active).toBe(true);
  });

  it('duplicate submissions run once; a reused key for another preview and a stale preview are refused', async () => {
    const f = await fixture();
    const p = await preview(f);
    const body = { previewFingerprint: p.body.previewFingerprint, idempotencyKey: 'range-cancel-e2e-dup' };
    const [a, b] = await Promise.all([execute(f, body), execute(f, body)]);
    expect([a.body.idempotentReplay ?? false, b.body.idempotentReplay ?? false].sort()).toEqual([false, true]);
    expect([...a.body.cancelledClassIds].sort()).toEqual([...b.body.cancelledClassIds].sort());
    expect(await prisma.auditLog.count({ where: { action: RANGE_CANCEL_AUDIT_ACTION } })).toBe(1);
    const retry = await execute(f, body);
    expect(retry.body).toMatchObject({ idempotentReplay: true, cancelledCount: p.body.totals.classes });

    const after = await preview(f);
    expect(after.body.totals.classes).toBe(0);
    await execute(f, { previewFingerprint: after.body.previewFingerprint, idempotencyKey: 'range-cancel-e2e-dup' }, 409);
    const stale = await execute(f, { previewFingerprint: p.body.previewFingerprint, idempotencyKey: 'range-cancel-e2e-new' }, 409);
    expect(stale.body.message).toContain('vista previa');
  });

  it('a booking or check-in after the preview refuses the whole operation; nothing is cancelled', async () => {
    const f = await fixture();
    const p = await preview(f);
    await createConfirmedBooking(prisma, f.studio.id, f.hiitWeek3.id, f.members[0]!.id);
    await execute(f, { previewFingerprint: p.body.previewFingerprint, idempotencyKey: 'range-cancel-e2e-stale1' }, 409);
    const p2 = await preview(f);
    await prisma.attendance.create({ data: { studioId: f.studio.id, scheduledClassId: f.hiitWeek1.id, userId: f.members[0]!.id, method: CheckInMethod.MANUAL, checkedInAt: new Date() } });
    await execute(f, { previewFingerprint: p2.body.previewFingerprint, idempotencyKey: 'range-cancel-e2e-stale2' }, 409);
    expect(await prisma.scheduledClass.count({ where: { studioId: f.studio.id, status: ClassStatus.CANCELLED } })).toBe(1);
    expect(await prisma.booking.count({ where: { studioId: f.studio.id, status: BookingStatus.CANCELLED } })).toBe(0);
  });

  it('past and in-progress classes inside the range are kept and reported', async () => {
    const f = await fixture();
    const now = Date.now();
    const past = await prisma.scheduledClass.create({
      data: { studioId: f.studio.id, classTemplateId: f.hiit.id, capacity: 2, status: ClassStatus.SCHEDULED, startsAt: new Date(now - 26 * 60 * MIN), endsAt: new Date(now - 25 * 60 * MIN) },
    });
    await createConfirmedBooking(prisma, f.studio.id, past.id, f.members[1]!.id);
    await prisma.attendance.create({ data: { studioId: f.studio.id, scheduledClassId: past.id, userId: f.members[1]!.id, method: CheckInMethod.MANUAL, checkedInAt: past.startsAt } });
    const running = await prisma.scheduledClass.create({
      data: { studioId: f.studio.id, classTemplateId: f.hiit.id, capacity: 2, status: ClassStatus.SCHEDULED, startsAt: new Date(now - 10 * MIN), endsAt: new Date(now + 50 * MIN) },
    });
    const body = { fromDate: D(-2), toDate: D(2), classTemplateIds: [f.hiit.id] };
    const p = await preview(f, body);
    expect((p.body.protectedClasses as Array<{ id: string; reason: string }>).map((c) => [c.id, c.reason]).sort()).toEqual(
      [[past.id, 'STARTED'], [running.id, 'STARTED']].sort(),
    );
    const res = await execute(f, { ...body, previewFingerprint: p.body.previewFingerprint, idempotencyKey: 'range-cancel-e2e-past' });
    expect(res.body.cancelledClassIds).not.toContain(past.id);
    expect(res.body.cancelledClassIds).not.toContain(running.id);
    expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id: past.id } })).status).toBe(ClassStatus.SCHEDULED);
    expect(await prisma.attendance.count({ where: { scheduledClassId: past.id } })).toBe(1);
    expect(await prisma.booking.count({ where: { scheduledClassId: past.id, status: BookingStatus.CONFIRMED } })).toBe(1);
  });

  it('enforces studio isolation, roles and input validation', async () => {
    const f = await fixture();
    await api().post(`${f.base}/preview`).set('Authorization', `Bearer ${f.otherOwnerToken}`).send({ fromDate: f.fromDate, toDate: f.toDate }).expect(403);
    const instructorToken = await token((await prisma.user.findUniqueOrThrow({ where: { id: f.i1.id } })).email);
    await api().post(`${f.base}/preview`).set('Authorization', `Bearer ${instructorToken}`).send({ fromDate: f.fromDate, toDate: f.toDate }).expect(403);
    await preview(f, { fromDate: f.toDate, toDate: f.fromDate }, 400);
    await preview(f, { toDate: addDaysToDateKey(f.fromDate, 200) }, 400);
    await preview(f, { fromDate: '2026-02-30' }, 400);
    const p = await preview(f);
    await execute(f, { previewFingerprint: p.body.previewFingerprint, idempotencyKey: 'range-cancel-e2e-val', confirm: false }, 400);
    expect(await prisma.scheduledClass.count({ where: { studioId: f.studio.id, status: ClassStatus.CANCELLED } })).toBe(1);
  });
});
