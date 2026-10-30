import type { INestApplication } from '@nestjs/common';
import { BookingStatus, CheckInMethod, ClassStatus, Role } from '@prisma/client';
import request from 'supertest';
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
 * A class that has already started (in progress or past) can never be cancelled by any path —
 * one-off cancel, "Solo esta clase", "Esta y las siguientes", entire / permanent series — so its
 * attendance and CONFIRMED bookings stay exactly as they were.
 */
describe('Cancelling started or past classes is refused (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seriesService: ScheduleSeriesService;

  const TZ = 'America/Mexico_City';
  const PASS = 'password12';
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    seriesService = app.get(ScheduleSeriesService);
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

  async function fixture() {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const owner = await seedUser(studio.id, Role.OWNER, 'owner');
    const member = await seedUser(studio.id, Role.MEMBER, 'member');
    await seriesService.createRecurringSeries(
      studio.id,
      { classTemplateId: tpl.id, daysOfWeek: [4], startTime: '07:15', intervalWeeks: 1, startsOn: '2026-08-20', endsOn: null, capacity: 12, confirmWarnings: true },
      owner.id,
    );
    const series = await prisma.scheduleTemplate.findFirstOrThrow({ where: { studioId: studio.id } });
    const linked = (startsAt: Date) => prisma.scheduledClass.create({
      data: { studioId: studio.id, classTemplateId: tpl.id, scheduleTemplateId: series.id, capacity: 5, status: ClassStatus.SCHEDULED, startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) },
    });
    const now = Date.now();
    const past = await linked(new Date(now - 2 * DAY - 7 * MIN));
    const inProgress = await linked(new Date(now - 10 * MIN));
    const future = await linked(new Date(now + 3 * DAY + 11 * MIN));
    const pastBooking = await createConfirmedBooking(prisma, studio.id, past.id, member.id);
    await prisma.attendance.create({ data: { studioId: studio.id, scheduledClassId: past.id, userId: member.id, method: CheckInMethod.MANUAL, checkedInAt: past.startsAt } });
    const inProgressBooking = await createConfirmedBooking(prisma, studio.id, inProgress.id, member.id);
    const futureBooking = await createConfirmedBooking(prisma, studio.id, future.id, member.id);
    return { studio, tpl, owner, series, past, inProgress, future, pastBooking, inProgressBooking, futureBooking, ownerToken: await token(owner.email) };
  }

  async function unchanged(classId: string, bookingId: string, updatedAt: Date) {
    const cls = await prisma.scheduledClass.findUniqueOrThrow({ where: { id: classId } });
    expect(cls.status).toBe(ClassStatus.SCHEDULED);
    expect(cls.updatedAt.getTime()).toBe(updatedAt.getTime());
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(BookingStatus.CONFIRMED);
  }

  const occurrenceUrl = (studioId: string, classId: string) => `/api/v1/studios/${studioId}/schedule-series/occurrences/${classId}`;

  it('refuses "Solo esta clase" and "Esta y las siguientes" on a past or in-progress occurrence', async () => {
    const f = await fixture();
    for (const [cls, booking] of [[f.past, f.pastBooking], [f.inProgress, f.inProgressBooking]] as const) {
      for (const scope of ['SINGLE', 'FOLLOWING']) {
        const preview = await request(app.getHttpServer())
          .post(`${occurrenceUrl(f.studio.id, cls.id)}/cancel-preview`)
          .set('Authorization', `Bearer ${f.ownerToken}`)
          .send({ scope })
          .expect(400);
        expect(preview.body.message).toContain('ya comenzó');
        await request(app.getHttpServer())
          .delete(occurrenceUrl(f.studio.id, cls.id))
          .set('Authorization', `Bearer ${f.ownerToken}`)
          .send({ scope, confirmReservations: true })
          .expect(400);
        await unchanged(cls.id, booking.id, cls.updatedAt);
      }
    }
    // "Esta y las siguientes" from a past class must not end the series in the past either.
    const series = await prisma.scheduleTemplate.findUniqueOrThrow({ where: { id: f.series.id } });
    expect(series.active).toBe(true);
    expect(series.endsAt).toEqual(f.series.endsAt);
    expect(await prisma.attendance.count({ where: { scheduledClassId: f.past.id } })).toBe(1);
  });

  it('"Esta y las siguientes" from a future class cancels only classes that have not started', async () => {
    const f = await fixture();
    await request(app.getHttpServer())
      .delete(occurrenceUrl(f.studio.id, f.future.id))
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ scope: 'FOLLOWING', confirmReservations: true })
      .expect(200);
    expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id: f.future.id } })).status).toBe(ClassStatus.CANCELLED);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: f.futureBooking.id } })).status).toBe(BookingStatus.CANCELLED);
    await unchanged(f.past.id, f.pastBooking.id, f.past.updatedAt);
    await unchanged(f.inProgress.id, f.inProgressBooking.id, f.inProgress.updatedAt);
  });

  it('entire-series cancellation from an occurrence leaves started classes untouched', async () => {
    const f = await fixture();
    await request(app.getHttpServer())
      .delete(occurrenceUrl(f.studio.id, f.future.id))
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .send({ scope: 'SERIES', confirmReservations: true })
      .expect(200);
    expect((await prisma.scheduleTemplate.findUniqueOrThrow({ where: { id: f.series.id } })).active).toBe(false);
    expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id: f.future.id } })).status).toBe(ClassStatus.CANCELLED);
    await unchanged(f.past.id, f.pastBooking.id, f.past.updatedAt);
    await unchanged(f.inProgress.id, f.inProgressBooking.id, f.inProgress.updatedAt);
  });

  it('refuses the one-off class cancel for a past or in-progress class, allows a future one', async () => {
    const f = await fixture();
    const now = Date.now();
    const oneOff = async (startsAt: Date) => {
      const cls = await createScheduledClass(prisma, f.studio.id, f.tpl.id, { startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) });
      const member = await seedUser(f.studio.id, Role.MEMBER, 'oneoff');
      return { cls, booking: await createConfirmedBooking(prisma, f.studio.id, cls.id, member.id) };
    };
    for (const startsAt of [new Date(now - DAY - 3 * MIN), new Date(now - 5 * MIN)]) {
      const { cls, booking } = await oneOff(startsAt);
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/studios/${f.studio.id}/schedule/${cls.id}`)
        .set('Authorization', `Bearer ${f.ownerToken}`)
        .expect(400);
      expect(res.body.message).toContain('ya comenzó');
      await unchanged(cls.id, booking.id, cls.updatedAt);
    }
    const { cls, booking } = await oneOff(new Date(now + 2 * DAY + 17 * MIN));
    await request(app.getHttpServer())
      .delete(`/api/v1/studios/${f.studio.id}/schedule/${cls.id}`)
      .set('Authorization', `Bearer ${f.ownerToken}`)
      .expect(204);
    expect((await prisma.scheduledClass.findUniqueOrThrow({ where: { id: cls.id } })).status).toBe(ClassStatus.CANCELLED);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(BookingStatus.CANCELLED);
  });
});
