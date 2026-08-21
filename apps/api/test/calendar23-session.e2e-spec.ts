import type { INestApplication } from '@nestjs/common';
import { BookingStatus, Role, WaitlistStatus } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
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
import { studioLocalTimeToUtc } from '../src/common/date/studio-local-date';

describe('Calendar 2.3 session operations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const TZ = 'America/Mexico_City';
  const ADMIN_PASS = 'password12';
  const CLASS_DATE = '2026-09-10';

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
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

  async function seedClassWithRoster(studioId: string, templateId: string) {
    const startsAt = studioLocalTimeToUtc(CLASS_DATE, '07:15', TZ);
    const endsAt = studioLocalTimeToUtc(CLASS_DATE, '08:15', TZ);
    const cls = await createScheduledClass(prisma, studioId, templateId, {
      startsAt,
      endsAt,
      capacity: 12,
    });
    const member = await createUserWithPassword(prisma, {
      email: `member-${Date.now()}@e2e.local`,
      password: ADMIN_PASS,
    });
    await createMembership(prisma, member.id, studioId, Role.MEMBER);
    const booking = await createConfirmedBooking(prisma, studioId, cls.id, member.id);
    await prisma.attendance.create({
      data: {
        studioId,
        scheduledClassId: cls.id,
        userId: member.id,
        method: 'QR',
        checkedInAt: new Date(startsAt.getTime() + 3 * 60_000),
      },
    });
    const waitMember = await createUserWithPassword(prisma, {
      email: `wait-${Date.now()}@e2e.local`,
      password: ADMIN_PASS,
    });
    await createMembership(prisma, waitMember.id, studioId, Role.MEMBER);
    await prisma.waitlistEntry.create({
      data: {
        studioId,
        scheduledClassId: cls.id,
        userId: waitMember.id,
        status: WaitlistStatus.WAITING,
        position: 1,
      },
    });
    return { cls, member, booking, waitMember };
  }

  it('GET session returns operational projection with roster, attendance, waitlist, occupancy', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const { cls, member, waitMember } = await seedClassWithRoster(studio.id, tpl.id);
    const admin = await seedAdmin(studio.id);
    const token = await loginToken(admin.email);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule/${cls.id}/session`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = res.body as {
      occupancy: { booked: number; waitlist: number; attended: number; capacity: number };
      roster: Array<{ userId: string; operationalStatus: string; checkedInAt: string | null }>;
      waitlist: Array<{ userId: string; position: number }>;
      class: { classTemplate: { name: string } };
    };

    expect(body.class.classTemplate.name).toBeTruthy();
    expect(body.occupancy.booked).toBe(1);
    expect(body.occupancy.attended).toBe(1);
    expect(body.occupancy.waitlist).toBe(1);
    expect(body.occupancy.capacity).toBe(12);
    expect(body.roster.some((r) => r.userId === member.id && r.operationalStatus === 'ATTENDED')).toBe(true);
    expect(body.waitlist[0]?.userId).toBe(waitMember.id);
    expect(body.waitlist[0]?.position).toBe(1);
  });

  async function seedEntitledMember(studioId: string) {
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studioId, Role.MEMBER);
    const plan = await createMembershipPlanForStudio(prisma, studioId);
    await createActiveSubscription(prisma, studioId, member.id, plan.id);
    return member;
  }

  it('staff manual booking attaches to scheduled class', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const startsAt = studioLocalTimeToUtc(CLASS_DATE, '09:00', TZ);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt,
      endsAt: studioLocalTimeToUtc(CLASS_DATE, '10:00', TZ),
      capacity: 12,
    });
    const member = await seedEntitledMember(studio.id);
    const admin = await seedAdmin(studio.id);
    const token = await loginToken(admin.email);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/members/${member.id}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .send({ scheduledClassId: cls.id })
      .expect(201);

    const session = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule/${cls.id}/session`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const roster = (session.body as { roster: Array<{ userId: string; operationalStatus: string }> }).roster;
    expect(roster.some((r) => r.userId === member.id && r.operationalStatus === 'RESERVED')).toBe(true);

    const booking = await prisma.booking.findFirst({
      where: { scheduledClassId: cls.id, userId: member.id, status: BookingStatus.CONFIRMED },
    });
    expect(booking).toBeTruthy();
  });

  it('duplicate booking is rejected for staff booking', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const startsAt = studioLocalTimeToUtc(CLASS_DATE, '11:00', TZ);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt,
      endsAt: studioLocalTimeToUtc(CLASS_DATE, '12:00', TZ),
      capacity: 12,
    });
    const member = await seedEntitledMember(studio.id);
    await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const admin = await seedAdmin(studio.id);
    const token = await loginToken(admin.email);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/members/${member.id}/bookings`)
      .set('Authorization', `Bearer ${token}`)
      .send({ scheduledClassId: cls.id })
      .expect(409);
  });

  it('staff force check-in registers attendance visible in session', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const start = new Date(Date.now() + 10 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 12,
    });
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const booking = await createConfirmedBooking(prisma, studio.id, cls.id, member.id);
    const staffUser = await createUserWithPassword(prisma, { password: ADMIN_PASS });
    await createMembership(prisma, staffUser.id, studio.id, Role.STAFF);
    const token = await loginToken(staffUser.email);

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/members/${member.id}/bookings/${booking.id}/check-in`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const session = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule/${cls.id}/session`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const roster = (session.body as { roster: Array<{ userId: string; operationalStatus: string }> }).roster;
    expect(roster.some((r) => r.userId === member.id && r.operationalStatus === 'ATTENDED')).toBe(true);
  });

  it('recurring occurrence exposes series context in session', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const template = await prisma.scheduleTemplate.create({
      data: {
        studioId: studio.id,
        classTemplateId: tpl.id,
        dayOfWeek: 4,
        startTime: '07:15',
        startsAt: null,
        intervalWeeks: 1,
        active: true,
      },
    });
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc(CLASS_DATE, '07:15', TZ),
      endsAt: studioLocalTimeToUtc(CLASS_DATE, '08:15', TZ),
      capacity: 12,
    });
    await prisma.scheduledClass.update({
      where: { id: cls.id },
      data: { scheduleTemplateId: template.id },
    });
    const admin = await seedAdmin(studio.id);
    const token = await loginToken(admin.email);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule/${cls.id}/session`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const seriesContext = (res.body as { seriesContext: { isRecurring: boolean; scheduleTemplateId?: string } })
      .seriesContext;
    expect(seriesContext.isRecurring).toBe(true);
    expect(seriesContext.scheduleTemplateId).toBe(template.id);
  });

  it('MEMBER role cannot read session projection', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc(CLASS_DATE, '07:00', TZ),
      endsAt: studioLocalTimeToUtc(CLASS_DATE, '08:00', TZ),
    });
    const member = await createUserWithPassword(prisma, { password: ADMIN_PASS });
    await createMembership(prisma, member.id, studio.id, Role.MEMBER);
    const token = await loginToken(member.email);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule/${cls.id}/session`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('STAFF can read session projection', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc(CLASS_DATE, '07:00', TZ),
      endsAt: studioLocalTimeToUtc(CLASS_DATE, '08:00', TZ),
    });
    const staff = await createUserWithPassword(prisma, { password: ADMIN_PASS });
    await createMembership(prisma, staff.id, studio.id, Role.STAFF);
    const token = await loginToken(staff.email);

    await request(app.getHttpServer())
      .get(`/api/v1/studios/${studio.id}/schedule/${cls.id}/session`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
