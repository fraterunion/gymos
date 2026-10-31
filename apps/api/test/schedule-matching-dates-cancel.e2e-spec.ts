import type { INestApplication } from '@nestjs/common';
import { BookingStatus, CheckInMethod, ClassStatus, Role, WaitlistStatus } from '@prisma/client';
import request from 'supertest';
import { addDaysToDateKey, getDayOfWeekFromDateKey, getStudioLocalDateKey, studioLocalTimeToUtc } from '../src/common/date/studio-local-date';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScheduleGeneratorService } from '../src/schedule-generator/schedule-generator.service';
import { MATCHING_DATES_CANCEL_AUDIT_ACTION } from '../src/schedule/schedule-matching-dates-cancellation.service';
import { MATCHING_DATES_TOMBSTONE_PREFIX } from '../src/schedule/schedule-matching-dates-tombstone';
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
 * Unlinked classes that share a studio-local weekday and start time (Booty Lab Thu 07:15)
 * can be cancelled together from one session, without touching other times, other class
 * types with the same name, other instructors, or series-linked copies.
 */
describe('Matching future dates cancellation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let generator: ScheduleGeneratorService;

  const TZ = 'America/Mexico_City';
  const PASS = 'password12';
  const MIN = 60_000;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    generator = app.get(ScheduleGeneratorService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  const api = () => request(app.getHttpServer());

  function futureThursdays(count: number): string[] {
    const out: string[] = [];
    let key = getStudioLocalDateKey(new Date(), TZ);
    while (out.length < count) {
      key = addDaysToDateKey(key, 1);
      if (getDayOfWeekFromDateKey(key) !== 4) continue;
      if (studioLocalTimeToUtc(key, '07:15', TZ).getTime() <= Date.now()) continue;
      out.push(key);
    }
    return out;
  }

  async function seed() {
    const [d0, d1, d2, d3, d4, d5] = futureThursdays(6);
    const studio = await createStudio(prisma, { timezone: TZ });
    const booty = await createClassTemplate(prisma, studio.id, { name: 'Booty Lab' });
    const sameName = await createClassTemplate(prisma, studio.id, { name: 'Booty Lab' });
    const owner = await createUserWithPassword(prisma, { email: `owner-${Date.now()}@e2e.local`, password: PASS });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const etzia = await createUserWithPassword(prisma, { email: `etzia-${Date.now()}@e2e.local`, password: PASS });
    await prisma.user.update({ where: { id: etzia.id }, data: { firstName: 'Etzia', lastName: 'Ferrabone' } });
    await createMembership(prisma, etzia.id, studio.id, Role.INSTRUCTOR);
    const otherInstructor = await createUserWithPassword(prisma, { email: `other-${Date.now()}@e2e.local`, password: PASS });
    await createMembership(prisma, otherInstructor.id, studio.id, Role.INSTRUCTOR);
    const member = await createUserWithPassword(prisma, { email: `member-${Date.now()}@e2e.local`, password: PASS });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const member2 = await createUserWithPassword(prisma, { email: `member2-${Date.now()}@e2e.local`, password: PASS });
    await createMembership(prisma, member2.id, studio.id, Role.MEMBER);

    const at = (date: string, time: string) => studioLocalTimeToUtc(date, time, TZ);
    const slot = (date: string, time: string, opts: { templateId?: string; instructorId?: string | null; seriesId?: string | null } = {}) =>
      prisma.scheduledClass.create({
        data: {
          studioId: studio.id,
          classTemplateId: opts.templateId ?? booty.id,
          instructorId: opts.instructorId === undefined ? etzia.id : opts.instructorId,
          scheduleTemplateId: opts.seriesId ?? null,
          capacity: 12,
          status: ClassStatus.SCHEDULED,
          startsAt: at(date, time),
          endsAt: new Date(at(date, time).getTime() + 60 * MIN),
        },
      });

    const series = await prisma.scheduleTemplate.create({
      data: {
        studioId: studio.id,
        classTemplateId: booty.id,
        instructorId: etzia.id,
        dayOfWeek: 4,
        startTime: '07:15',
        capacity: 12,
        active: true,
        startsAt: at(d0, '07:15'),
      },
    });

    const week0 = await slot(d0, '07:15');
    const week1 = await slot(d1, '07:15');
    const week2 = await slot(d2, '07:15');
    const evening = await slot(d0, '18:00');
    const otherCoach = await slot(d3, '07:15', { instructorId: otherInstructor.id });
    const attended = await slot(d4, '07:15');
    const decoyName = await slot(d0, '07:15', { templateId: sameName.id });
    const earlyLocal = await slot(d1, '01:15');
    const linked = await slot(d5, '07:15', { seriesId: series.id });

    await createConfirmedBooking(prisma, studio.id, week0.id, member.id);
    await prisma.waitlistEntry.create({
      data: { studioId: studio.id, scheduledClassId: week2.id, userId: member2.id, status: WaitlistStatus.WAITING, position: 1 },
    });
    await createConfirmedBooking(prisma, studio.id, attended.id, member.id);
    await prisma.attendance.create({
      data: { studioId: studio.id, scheduledClassId: attended.id, userId: member.id, method: CheckInMethod.MANUAL, checkedInAt: new Date() },
    });

    const login = await api().post('/api/v1/auth/login').send({ email: owner.email, password: PASS }).expect(201);
    return {
      studio, booty, sameName, owner, etzia, otherInstructor, member, series,
      d0, d1, d2, d3, d4, d5,
      week0, week1, week2, evening, otherCoach, attended, decoyName, earlyLocal, linked,
      token: (login.body as { accessToken: string }).accessToken,
      base: `/api/v1/studios/${studio.id}/schedule-operations/matching-dates-cancel`,
    };
  }

  type Seed = Awaited<ReturnType<typeof seed>>;

  function preview(seeded: Seed, body: Record<string, unknown> = {}, status = 200) {
    return api()
      .post(`${seeded.base}/preview`)
      .set('Authorization', `Bearer ${seeded.token}`)
      .send({ scheduledClassId: seeded.week1.id, includeOtherInstructors: false, ...body })
      .expect(status);
  }

  function execute(seeded: Seed, body: Record<string, unknown>, status = 200) {
    return api()
      .post(seeded.base)
      .set('Authorization', `Bearer ${seeded.token}`)
      .send({ scheduledClassId: seeded.week1.id, includeOtherInstructors: false, confirm: true, ...body })
      .expect(status);
  }

  it('cancels three matching weeks and leaves every other Booty Lab slot', async () => {
    const seeded = await seed();
    const seen = await preview(seeded);
    const ids = (seen.body.classes as Array<{ id: string; localTime: string }>).map((row) => row.id).sort();
    expect(ids).toEqual([seeded.week0.id, seeded.week1.id, seeded.week2.id].sort());
    expect(seen.body.classes.every((row: { localTime: string }) => row.localTime === '07:15')).toBe(true);
    expect(seen.body.totals).toMatchObject({ classes: 3, bookings: 1, waitlist: 1, protected: 1 });
    expect((seen.body.protectedClasses as Array<{ id: string; reason: string }>)[0]).toMatchObject({
      id: seeded.attended.id,
      reason: 'ATTENDED',
    });
    expect(seen.body.excludedClasses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: seeded.otherCoach.id, reason: 'OTHER_INSTRUCTOR' }),
      expect.objectContaining({ id: seeded.linked.id, reason: 'SERIES' }),
    ]));

    const done = await execute(seeded, {
      previewFingerprint: seen.body.previewFingerprint,
      idempotencyKey: 'matching-dates-1',
      cancelReason: 'Etzia de viaje',
    });
    expect(done.body).toMatchObject({
      cancelledCount: 3,
      cancelledBookingCount: 1,
      expiredWaitlistCount: 1,
    });

    const again = await execute(seeded, {
      previewFingerprint: seen.body.previewFingerprint,
      idempotencyKey: 'matching-dates-1',
    });
    expect(again.body.idempotentReplay).toBe(true);
    expect(await prisma.booking.count({ where: { scheduledClassId: seeded.week0.id, status: BookingStatus.CANCELLED } })).toBe(1);

    for (const id of [seeded.week0.id, seeded.week1.id, seeded.week2.id]) {
      const row = await prisma.scheduledClass.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe(ClassStatus.CANCELLED);
      expect(row.cancelReason?.startsWith(MATCHING_DATES_TOMBSTONE_PREFIX)).toBe(true);
      expect(row.scheduleTemplateId).toBeNull();
    }
    expect(await prisma.waitlistEntry.findFirstOrThrow({ where: { scheduledClassId: seeded.week2.id } })).toMatchObject({
      status: WaitlistStatus.EXPIRED,
    });
    for (const id of [seeded.evening.id, seeded.otherCoach.id, seeded.attended.id, seeded.decoyName.id, seeded.earlyLocal.id, seeded.linked.id]) {
      expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id } })).status).toBe(ClassStatus.SCHEDULED);
    }
    expect(await prisma.auditLog.count({
      where: { studioId: seeded.studio.id, action: MATCHING_DATES_CANCEL_AUDIT_ACTION },
    })).toBe(1);

    await generator.generateRange(
      seeded.studio.id,
      new Date(),
      new Date(studioLocalTimeToUtc(seeded.d5, '23:00', TZ).getTime() + 86_400_000),
      { isDryRun: false, triggeredBy: 'MANUAL' },
    );
    for (const id of [seeded.week0.id, seeded.week2.id]) {
      expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id } })).status).toBe(ClassStatus.CANCELLED);
    }
    expect(await prisma.scheduledClass.count({
      where: {
        studioId: seeded.studio.id,
        classTemplateId: seeded.booty.id,
        startsAt: { in: [seeded.week0.startsAt, seeded.week2.startsAt] },
        status: ClassStatus.SCHEDULED,
      },
    })).toBe(0);

    const recreated = await api()
      .post(`/api/v1/studios/${seeded.studio.id}/schedule`)
      .set('Authorization', `Bearer ${seeded.token}`)
      .send({
        templateId: seeded.booty.id,
        instructorId: seeded.etzia.id,
        localStart: { date: seeded.d1, time: '07:15' },
      })
      .expect(201);
    expect(recreated.body.id).toBe(seeded.week1.id);
    expect(recreated.body.status).toBe(ClassStatus.SCHEDULED);
    expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id: seeded.week0.id } })).status).toBe(ClassStatus.CANCELLED);
  });

  it('cancels the other instructor only when that choice is explicit', async () => {
    const seeded = await seed();
    const narrow = await preview(seeded);
    expect((narrow.body.classes as Array<{ id: string }>).some((row) => row.id === seeded.otherCoach.id)).toBe(false);
    const wide = await preview(seeded, { includeOtherInstructors: true });
    expect((wide.body.classes as Array<{ id: string }>).some((row) => row.id === seeded.otherCoach.id)).toBe(true);
    await execute(seeded, {
      includeOtherInstructors: true,
      previewFingerprint: wide.body.previewFingerprint,
      idempotencyKey: 'matching-dates-instructors',
    });
    expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id: seeded.otherCoach.id } })).status).toBe(ClassStatus.CANCELLED);
    expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id: seeded.evening.id } })).status).toBe(ClassStatus.SCHEDULED);
  });

  it('refuses a stale preview and does not cancel', async () => {
    const seeded = await seed();
    const seen = await preview(seeded);
    await createConfirmedBooking(prisma, seeded.studio.id, seeded.week1.id, seeded.member.id);
    await execute(seeded, {
      previewFingerprint: seen.body.previewFingerprint,
      idempotencyKey: 'matching-dates-stale',
    }, 409);
    expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id: seeded.week1.id } })).status).toBe(ClassStatus.SCHEDULED);
    expect(await prisma.booking.count({ where: { scheduledClassId: seeded.week0.id, status: BookingStatus.CONFIRMED } })).toBe(1);
  });
});
