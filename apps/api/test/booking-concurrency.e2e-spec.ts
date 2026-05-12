import type { INestApplication } from '@nestjs/common';
import { BookingStatus, Role } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createActiveSubscription,
  createClassTemplate,
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

describe('Booking concurrency (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

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

  it('serializes capacity-1 class: exactly one booking succeeds, count stays 1', async () => {
    const studio = await createStudio(prisma);
    const plan = await createMembershipPlanForStudio(prisma, studio.id);
    const tpl = await createClassTemplate(prisma, studio.id);
    const start = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 3600000);
    const cls = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: start,
      endsAt: end,
      capacity: 1,
    });

    const u1 = await createUserWithPassword(prisma, { email: 'conc-a@e2e.local', password: 'password12' });
    const u2 = await createUserWithPassword(prisma, { email: 'conc-b@e2e.local', password: 'password12' });
    await createMembership(prisma, u1.id, studio.id, Role.MEMBER);
    await createMembership(prisma, u2.id, studio.id, Role.MEMBER);
    await createActiveSubscription(prisma, studio.id, u1.id, plan.id);
    await createActiveSubscription(prisma, studio.id, u2.id, plan.id);

    const t1 = await loginAccessToken(app, u1.email, u1.password);
    const t2 = await loginAccessToken(app, u2.email, u2.password);

    const url = `/api/v1/studios/${studio.id}/classes/${cls.id}/bookings`;
    const p1 = request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${t1}`);
    const p2 = request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${t2}`);
    const [r1, r2] = await Promise.all([p1, p2]);

    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([201, 409]);

    const confirmed = await prisma.booking.count({
      where: { scheduledClassId: cls.id, status: BookingStatus.CONFIRMED },
    });
    expect(confirmed).toBe(1);
  });
});
