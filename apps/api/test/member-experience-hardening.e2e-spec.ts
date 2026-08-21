import type { INestApplication } from '@nestjs/common';
import {
  BookingStatus,
  CheckInMethod,
  ClassStatus,
  Role,
  WaitlistStatus,
  BillingInterval,
} from '@prisma/client';
import request from 'supertest';
import { MEMBER_ERRORS } from '../src/member-facing/member-errors';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScheduleOperationsService } from '../src/schedule/schedule-operations.service';
import { BulkScheduleOperation } from '../src/schedule/dto/schedule-operations.dto';
import { ScheduleSeriesService } from '../src/schedule/schedule-series.service';
import {
  applyWeekReconciliationPlanBatched,
  WEEK_RECONCILIATION_TX_OPTIONS,
} from '../src/schedule/schedule-week-reconciliation-apply';
import { WaitlistService } from '../src/waitlist/waitlist.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createActiveSubscription,
  createClassTemplate,
  createConfirmedBooking,
  createMembership,
  createMembershipPlanForStudio,
  createScheduledClass,
  createStudio,
  createUserWithPassword,
} from './helpers/factories';

async function loginAccessToken(
  app: INestApplication,
  email: string,
  password: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

function futureClassDates(hoursFromNow = 48) {
  const start = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start, end };
}

describe('Member experience reliability hardening (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let waitlistService: WaitlistService;
  let ops: ScheduleOperationsService;
  let seriesService: ScheduleSeriesService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    waitlistService = app.get(WaitlistService);
    ops = app.get(ScheduleOperationsService);
    seriesService = app.get(ScheduleSeriesService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedAdmin(studioId: string) {
    const admin = await createUserWithPassword(prisma, {
      email: `admin-${Date.now()}@e2e.local`,
    });
    await createMembership(prisma, admin.id, studioId, Role.ADMIN);
    return admin;
  }

  describe('cancelled-class booking lifecycle', () => {
    it('cancelling a class cancels CONFIRMED bookings, expires WAITING, and keeps attendance', async () => {
      const studio = await createStudio(prisma);
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const tpl = await createClassTemplate(prisma, studio.id);
      const { start, end } = futureClassDates();
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: start,
        endsAt: end,
        capacity: 1,
      });
      const holder = await createUserWithPassword(prisma, { email: 'hold-cancel@e2e.local' });
      const waiter = await createUserWithPassword(prisma, { email: 'wait-cancel@e2e.local' });
      await createMembership(prisma, holder.id, studio.id, Role.MEMBER);
      await createMembership(prisma, waiter.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, holder.id, plan.id);
      await createActiveSubscription(prisma, studio.id, waiter.id, plan.id);
      const booking = await createConfirmedBooking(prisma, studio.id, cls.id, holder.id);
      await prisma.attendance.create({
        data: {
          studioId: studio.id,
          scheduledClassId: cls.id,
          userId: holder.id,
          method: CheckInMethod.MANUAL,
        },
      });
      await prisma.waitlistEntry.create({
        data: {
          studioId: studio.id,
          scheduledClassId: cls.id,
          userId: waiter.id,
          status: WaitlistStatus.WAITING,
          position: 1,
        },
      });
      const admin = await seedAdmin(studio.id);
      const adminTok = await loginAccessToken(app, admin.email, admin.password);

      await request(app.getHttpServer())
        .delete(`/api/v1/studios/${studio.id}/schedule/${cls.id}`)
        .set('Authorization', `Bearer ${adminTok}`)
        .expect(204);

      const classRow = await prisma.scheduledClass.findUniqueOrThrow({ where: { id: cls.id } });
      expect(classRow.status).toBe(ClassStatus.CANCELLED);

      const bookingRow = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(bookingRow.status).toBe(BookingStatus.CANCELLED);

      const waitRow = await prisma.waitlistEntry.findFirstOrThrow({
        where: { scheduledClassId: cls.id, userId: waiter.id },
      });
      expect(waitRow.status).toBe(WaitlistStatus.EXPIRED);

      const attendance = await prisma.attendance.findMany({ where: { scheduledClassId: cls.id } });
      expect(attendance).toHaveLength(1);

      const holderTok = await loginAccessToken(app, holder.email, holder.password);
      const me = await request(app.getHttpServer())
        .get(`/api/v1/studios/${studio.id}/bookings/me`)
        .set('Authorization', `Bearer ${holderTok}`)
        .expect(200);
      expect((me.body as { id: string }[]).some((row) => row.id === booking.id)).toBe(false);
    });

    it('series SINGLE cancellation applies the same booking/waitlist invariant', async () => {
      const studio = await createStudio(prisma, { timezone: 'America/Mexico_City' });
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const tpl = await createClassTemplate(prisma, studio.id);
      const admin = await seedAdmin(studio.id);
      await seriesService.createRecurringSeries(
        studio.id,
        {
          classTemplateId: tpl.id,
          daysOfWeek: [3],
          startTime: '07:00',
          intervalWeeks: 1,
          startsOn: '2026-09-02',
          endsOn: '2026-09-02',
          capacity: 8,
          confirmWarnings: true,
        },
        admin.id,
      );
      const occurrence = await prisma.scheduledClass.findFirstOrThrow({
        where: { studioId: studio.id, classTemplateId: tpl.id },
      });
      const member = await createUserWithPassword(prisma, { email: 'series-book@e2e.local' });
      await createMembership(prisma, member.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, member.id, plan.id);
      const booking = await createConfirmedBooking(prisma, studio.id, occurrence.id, member.id);

      await seriesService.cancelOccurrence(
        studio.id,
        occurrence.id,
        'SINGLE',
        admin.id,
        'Hardening test',
        true,
      );

      expect(
        (await prisma.scheduledClass.findUniqueOrThrow({ where: { id: occurrence.id } })).status,
      ).toBe(ClassStatus.CANCELLED);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
        BookingStatus.CANCELLED,
      );
    });

    it('bulk cancel applies the same booking invariant', async () => {
      const studio = await createStudio(prisma);
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const tpl = await createClassTemplate(prisma, studio.id);
      const { start, end } = futureClassDates();
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
      const member = await createUserWithPassword(prisma, { email: 'bulk-book@e2e.local' });
      await createMembership(prisma, member.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, member.id, plan.id);
      const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
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

      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
        BookingStatus.CANCELLED,
      );
    });

    it('week reconciliation REMOVE applies the same booking invariant', async () => {
      const studio = await createStudio(prisma);
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const tpl = await createClassTemplate(prisma, studio.id);
      const { start, end } = futureClassDates();
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, { startsAt: start, endsAt: end });
      const member = await createUserWithPassword(prisma, { email: 'week-book@e2e.local' });
      await createMembership(prisma, member.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, member.id, plan.id);
      const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);

      await prisma.$transaction(async (tx) => {
        await applyWeekReconciliationPlanBatched(tx, studio.id, {
          actions: [{ kind: 'REMOVE', existingId: cls.id }],
          reusedCount: 0,
          createdCount: 0,
          updatedCount: 0,
          removedCount: 1,
          reviewCount: 0,
          blockedCount: 0,
          affectedReservationCount: 1,
        });
      }, WEEK_RECONCILIATION_TX_OPTIONS);

      expect(
        (await prisma.scheduledClass.findUniqueOrThrow({ where: { id: cls.id } })).status,
      ).toBe(ClassStatus.CANCELLED);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
        BookingStatus.CANCELLED,
      );
    });
  });

  describe('in-progress booking visibility', () => {
    it('keeps a CONFIRMED in-progress booking on GET /bookings/me until effective end', async () => {
      const studio = await createStudio(prisma);
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const tpl = await createClassTemplate(prisma, studio.id, { durationMinutes: 60 });
      const now = new Date();
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: new Date(now.getTime() - 10 * 60_000),
        endsAt: new Date(now.getTime() + 50 * 60_000),
      });
      const user = await createUserWithPassword(prisma, { email: 'inprog@e2e.local' });
      await createMembership(prisma, user.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, user.id, plan.id);
      const booking = await createConfirmedBooking(prisma, studio.id, cls.id, user.id);
      const tok = await loginAccessToken(app, user.email, user.password);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/studios/${studio.id}/bookings/me`)
        .set('Authorization', `Bearer ${tok}`)
        .expect(200);
      expect((res.body as { id: string }[]).some((row) => row.id === booking.id)).toBe(true);
    });

    it('hides a booking after effective end even with corrupt far-future endsAt', async () => {
      const studio = await createStudio(prisma);
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const tpl = await createClassTemplate(prisma, studio.id, { durationMinutes: 60 });
      const now = new Date();
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: new Date(now.getTime() - 2 * 60 * 60_000),
        endsAt: new Date(now.getTime() + 365 * 24 * 60 * 60_000),
      });
      const user = await createUserWithPassword(prisma, { email: 'corrupt-vis@e2e.local' });
      await createMembership(prisma, user.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, user.id, plan.id);
      const booking = await createConfirmedBooking(prisma, studio.id, cls.id, user.id);
      const tok = await loginAccessToken(app, user.email, user.password);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/studios/${studio.id}/bookings/me`)
        .set('Authorization', `Bearer ${tok}`)
        .expect(200);
      expect((res.body as { id: string }[]).some((row) => row.id === booking.id)).toBe(false);
    });
  });

  describe('waitlist promotion hardening', () => {
    it('rejects promotion into a started class and expires waiting entries', async () => {
      const studio = await createStudio(prisma);
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const tpl = await createClassTemplate(prisma, studio.id);
      const { start, end } = futureClassDates();
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: start,
        endsAt: end,
        capacity: 1,
      });
      const waiter = await createUserWithPassword(prisma, { email: 'prom-started@e2e.local' });
      await createMembership(prisma, waiter.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, waiter.id, plan.id);
      await prisma.waitlistEntry.create({
        data: {
          studioId: studio.id,
          scheduledClassId: cls.id,
          userId: waiter.id,
          status: WaitlistStatus.WAITING,
          position: 1,
        },
      });
      await prisma.scheduledClass.update({
        where: { id: cls.id },
        data: { startsAt: new Date(Date.now() - 60_000) },
      });

      const result = await waitlistService.promoteNextAfterSpotOpened(studio.id, cls.id);
      expect(result).toBeNull();
      expect(
        (await prisma.waitlistEntry.findFirstOrThrow({ where: { userId: waiter.id } })).status,
      ).toBe(WaitlistStatus.EXPIRED);
      expect(
        await prisma.booking.count({
          where: { scheduledClassId: cls.id, status: BookingStatus.CONFIRMED },
        }),
      ).toBe(0);
    });

    it('rejects promotion into a cancelled class', async () => {
      const studio = await createStudio(prisma);
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const tpl = await createClassTemplate(prisma, studio.id);
      const { start, end } = futureClassDates();
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: start,
        endsAt: end,
        capacity: 1,
      });
      const waiter = await createUserWithPassword(prisma, { email: 'prom-cancel@e2e.local' });
      await createMembership(prisma, waiter.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, waiter.id, plan.id);
      await prisma.waitlistEntry.create({
        data: {
          studioId: studio.id,
          scheduledClassId: cls.id,
          userId: waiter.id,
          status: WaitlistStatus.WAITING,
          position: 1,
        },
      });
      await prisma.scheduledClass.update({
        where: { id: cls.id },
        data: { status: ClassStatus.CANCELLED },
      });

      const result = await waitlistService.promoteNextAfterSpotOpened(studio.id, cls.id);
      expect(result).toBeNull();
      expect(
        (await prisma.waitlistEntry.findFirstOrThrow({ where: { userId: waiter.id } })).status,
      ).toBe(WaitlistStatus.EXPIRED);
    });

    it('revalidates entitlement and overlap, and respects credits', async () => {
      const studio = await createStudio(prisma);
      const plan = await prisma.membershipPlan.create({
        data: {
          studioId: studio.id,
          name: 'One credit',
          priceCents: 1000,
          currency: 'usd',
          billingInterval: BillingInterval.MONTHLY,
          active: true,
          classCredits: 1,
        },
      });
      const tpl = await createClassTemplate(prisma, studio.id);
      const { start, end } = futureClassDates(48);
      const other = futureClassDates(72);
      const fullClass = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: start,
        endsAt: end,
        capacity: 1,
      });
      const otherClass = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: other.start,
        endsAt: other.end,
        capacity: 8,
      });
      const holder = await createUserWithPassword(prisma, { email: 'cred-h@e2e.local' });
      const waiter = await createUserWithPassword(prisma, { email: 'cred-w@e2e.local' });
      await createMembership(prisma, holder.id, studio.id, Role.MEMBER);
      await createMembership(prisma, waiter.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, holder.id, plan.id);
      await createActiveSubscription(prisma, studio.id, waiter.id, plan.id);
      await createConfirmedBooking(prisma, studio.id, fullClass.id, holder.id);
      await prisma.waitlistEntry.create({
        data: {
          studioId: studio.id,
          scheduledClassId: fullClass.id,
          userId: waiter.id,
          status: WaitlistStatus.WAITING,
          position: 1,
        },
      });
      await createConfirmedBooking(prisma, studio.id, otherClass.id, waiter.id);

      const holderTok = await loginAccessToken(app, holder.email, holder.password);
      const holderBooking = await prisma.booking.findFirstOrThrow({
        where: { userId: holder.id, scheduledClassId: fullClass.id },
      });
      const res = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/bookings/${holderBooking.id}/cancel`)
        .set('Authorization', `Bearer ${holderTok}`)
        .expect(200);
      expect((res.body as { cancelled: boolean }).cancelled).toBe(true);
      expect((res.body as { promotion: unknown }).promotion).toBeNull();
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: holderBooking.id } })).status,
      ).toBe(BookingStatus.CANCELLED);
      expect(
        await prisma.booking.count({
          where: {
            scheduledClassId: fullClass.id,
            userId: waiter.id,
            status: BookingStatus.CONFIRMED,
          },
        }),
      ).toBe(0);
    });

    it('skips overlapping candidates and does not roll back the original cancellation', async () => {
      const studio = await createStudio(prisma);
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const tpl = await createClassTemplate(prisma, studio.id);
      const { start, end } = futureClassDates();
      const fullClass = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: start,
        endsAt: end,
        capacity: 1,
      });
      const overlapClass = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: new Date(start.getTime() + 15 * 60_000),
        endsAt: new Date(end.getTime() + 15 * 60_000),
        capacity: 8,
      });
      const holder = await createUserWithPassword(prisma, { email: 'ov-h@e2e.local' });
      const waiter = await createUserWithPassword(prisma, { email: 'ov-w@e2e.local' });
      await createMembership(prisma, holder.id, studio.id, Role.MEMBER);
      await createMembership(prisma, waiter.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, holder.id, plan.id);
      await createActiveSubscription(prisma, studio.id, waiter.id, plan.id);
      const holderBooking = await createConfirmedBooking(prisma, studio.id, fullClass.id, holder.id);
      await createConfirmedBooking(prisma, studio.id, overlapClass.id, waiter.id);
      await prisma.waitlistEntry.create({
        data: {
          studioId: studio.id,
          scheduledClassId: fullClass.id,
          userId: waiter.id,
          status: WaitlistStatus.WAITING,
          position: 1,
        },
      });

      const holderTok = await loginAccessToken(app, holder.email, holder.password);
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/bookings/${holderBooking.id}/cancel`)
        .set('Authorization', `Bearer ${holderTok}`)
        .expect(200);

      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: holderBooking.id } })).status,
      ).toBe(BookingStatus.CANCELLED);
      expect(
        await prisma.booking.count({
          where: {
            scheduledClassId: fullClass.id,
            userId: waiter.id,
            status: BookingStatus.CONFIRMED,
          },
        }),
      ).toBe(0);
    });

    it('does not roll back cancellation when the waiter is already CONFIRMED (P2002)', async () => {
      const studio = await createStudio(prisma);
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const tpl = await createClassTemplate(prisma, studio.id);
      const { start, end } = futureClassDates();
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: start,
        endsAt: end,
        capacity: 2,
      });
      const holder = await createUserWithPassword(prisma, { email: 'p2002-h@e2e.local' });
      const waiter = await createUserWithPassword(prisma, { email: 'p2002-w@e2e.local' });
      await createMembership(prisma, holder.id, studio.id, Role.MEMBER);
      await createMembership(prisma, waiter.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, holder.id, plan.id);
      await createActiveSubscription(prisma, studio.id, waiter.id, plan.id);
      const holderBooking = await createConfirmedBooking(prisma, studio.id, cls.id, holder.id);
      await createConfirmedBooking(prisma, studio.id, cls.id, waiter.id);
      await prisma.waitlistEntry.create({
        data: {
          studioId: studio.id,
          scheduledClassId: cls.id,
          userId: waiter.id,
          status: WaitlistStatus.WAITING,
          position: 1,
        },
      });

      const holderTok = await loginAccessToken(app, holder.email, holder.password);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/bookings/${holderBooking.id}/cancel`)
        .set('Authorization', `Bearer ${holderTok}`)
        .expect(200);
      expect((res.body as { cancelled: boolean }).cancelled).toBe(true);
      expect(
        (await prisma.booking.findUniqueOrThrow({ where: { id: holderBooking.id } })).status,
      ).toBe(BookingStatus.CANCELLED);
      expect(
        (await prisma.waitlistEntry.findFirstOrThrow({ where: { userId: waiter.id } })).status,
      ).toBe(WaitlistStatus.EXPIRED);
    });

    it('promotion race cannot oversell a single seat', async () => {
      const studio = await createStudio(prisma);
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const tpl = await createClassTemplate(prisma, studio.id);
      const { start, end } = futureClassDates();
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: start,
        endsAt: end,
        capacity: 1,
      });
      const a = await createUserWithPassword(prisma, { email: 'race-a@e2e.local' });
      const b = await createUserWithPassword(prisma, { email: 'race-b@e2e.local' });
      await createMembership(prisma, a.id, studio.id, Role.MEMBER);
      await createMembership(prisma, b.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, a.id, plan.id);
      await createActiveSubscription(prisma, studio.id, b.id, plan.id);
      await prisma.waitlistEntry.createMany({
        data: [
          {
            studioId: studio.id,
            scheduledClassId: cls.id,
            userId: a.id,
            status: WaitlistStatus.WAITING,
            position: 1,
          },
          {
            studioId: studio.id,
            scheduledClassId: cls.id,
            userId: b.id,
            status: WaitlistStatus.WAITING,
            position: 2,
          },
        ],
      });

      const [first, second] = await Promise.all([
        waitlistService.promoteNextAfterSpotOpened(studio.id, cls.id),
        waitlistService.promoteNextAfterSpotOpened(studio.id, cls.id),
      ]);
      const performed = [first, second].filter(Boolean);
      expect(performed).toHaveLength(1);
      expect(
        await prisma.booking.count({
          where: { scheduledClassId: cls.id, status: BookingStatus.CONFIRMED },
        }),
      ).toBe(1);
    });
  });

  describe('generator RBAC', () => {
    it('denies MEMBER access to generator status and runs', async () => {
      const studio = await createStudio(prisma);
      const member = await createUserWithPassword(prisma, { email: 'gen-member@e2e.local' });
      await createMembership(prisma, member.id, studio.id, Role.MEMBER);
      const tok = await loginAccessToken(app, member.email, member.password);

      await request(app.getHttpServer())
        .get(`/api/v1/studios/${studio.id}/schedule-generator/status`)
        .set('Authorization', `Bearer ${tok}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/api/v1/studios/${studio.id}/schedule-generator/runs`)
        .set('Authorization', `Bearer ${tok}`)
        .expect(403);
    });

    it('allows OWNER to read generator status', async () => {
      const studio = await createStudio(prisma);
      const owner = await createUserWithPassword(prisma, { email: 'gen-owner@e2e.local' });
      await createMembership(prisma, owner.id, studio.id, Role.OWNER);
      const tok = await loginAccessToken(app, owner.email, owner.password);

      await request(app.getHttpServer())
        .get(`/api/v1/studios/${studio.id}/schedule-generator/status`)
        .set('Authorization', `Bearer ${tok}`)
        .expect(200);
    });
  });

  describe('member-facing Spanish errors', () => {
    it('maps expected booking conflicts to Spanish without Prisma/Nest internals', async () => {
      const studio = await createStudio(prisma);
      const plan = await createMembershipPlanForStudio(prisma, studio.id);
      const tpl = await createClassTemplate(prisma, studio.id);
      const { start, end } = futureClassDates();
      const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: start,
        endsAt: end,
        capacity: 2,
      });
      const user = await createUserWithPassword(prisma, { email: 'es-book@e2e.local' });
      await createMembership(prisma, user.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, user.id, plan.id);
      const tok = await loginAccessToken(app, user.email, user.password);

      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
        .set('Authorization', `Bearer ${tok}`)
        .expect(201);
      const dup = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
        .set('Authorization', `Bearer ${tok}`)
        .expect(409);
      expect((dup.body as { message: string }).message).toBe(MEMBER_ERRORS.alreadyBooked);
      expect(JSON.stringify(dup.body)).not.toMatch(/Prisma|P2002|Internal server error/i);

      const other = await createUserWithPassword(prisma, { email: 'es-full@e2e.local' });
      await createMembership(prisma, other.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, other.id, plan.id);
      const otherTok = await loginAccessToken(app, other.email, other.password);
      await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
        .set('Authorization', `Bearer ${otherTok}`)
        .expect(201);
      const third = await createUserWithPassword(prisma, { email: 'es-full-3@e2e.local' });
      await createMembership(prisma, third.id, studio.id, Role.MEMBER);
      await createActiveSubscription(prisma, studio.id, third.id, plan.id);
      const thirdTok = await loginAccessToken(app, third.email, third.password);
      const full = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`)
        .set('Authorization', `Bearer ${thirdTok}`)
        .expect(409);
      expect((full.body as { message: string }).message).toBe(MEMBER_ERRORS.classFull);

      const started = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60 * 60_000),
      });
      const startedRes = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${started.id}/bookings`)
        .set('Authorization', `Bearer ${tok}`)
        .expect(409);
      expect((startedRes.body as { message: string }).message).toBe(MEMBER_ERRORS.classAlreadyStarted);

      const cancelled = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: new Date(Date.now() + 80 * 60 * 60_000),
        endsAt: new Date(Date.now() + 81 * 60 * 60_000),
        status: ClassStatus.CANCELLED,
      });
      const cancelledRes = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${cancelled.id}/bookings`)
        .set('Authorization', `Bearer ${tok}`)
        .expect(409);
      expect((cancelledRes.body as { message: string }).message).toBe(MEMBER_ERRORS.classNotOpen);

      const expiredUser = await createUserWithPassword(prisma, { email: 'es-exp@e2e.local' });
      await createMembership(prisma, expiredUser.id, studio.id, Role.MEMBER);
      const expTok = await loginAccessToken(app, expiredUser.email, expiredUser.password);
      const openCls = await createScheduledClass(prisma, studio.id, tpl.id, {
        startsAt: new Date(Date.now() + 90 * 60 * 60_000),
        endsAt: new Date(Date.now() + 91 * 60 * 60_000),
      });
      const expiredRes = await request(app.getHttpServer())
        .post(`/api/v1/studios/${studio.id}/classes/${openCls.id}/bookings`)
        .set('Authorization', `Bearer ${expTok}`)
        .expect(403);
      expect((expiredRes.body as { message: string }).message).toBe(
        MEMBER_ERRORS.membershipOrDayPassRequired,
      );
    });
  });
});
