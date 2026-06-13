import type { INestApplication } from '@nestjs/common';
import { Role, StaffType } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';

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

function addStaffPayload(overrides: Record<string, unknown> = {}) {
  return {
    email: 'newstaff@e2e.local',
    firstName: 'New',
    lastName: 'Staff',
    role: Role.STAFF,
    staffType: StaffType.FRONT_DESK,
    temporaryPassword: 'TempPass2026!',
    ...overrides,
  };
}

describe('Staff account passwords (e2e)', () => {
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

  async function ownerContext() {
    const studio = await createStudio(prisma);
    const owner = await createUserWithPassword(prisma, {
      email: 'owner-staff@e2e.local',
      password: 'password12',
    });
    await createMembership(prisma, owner.id, studio.id, Role.OWNER);
    const token = await loginAccessToken(app, owner.email, owner.password);
    return { studio, owner, token };
  }

  it('returns 400 when creating new staff without temporaryPassword', async () => {
    const { studio, token } = await ownerContext();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        addStaffPayload({
          temporaryPassword: undefined,
        }),
      )
      .expect(400);

    expect((res.body as { message: string }).message).toContain(
      'Temporary password is required for new staff accounts.',
    );
  });

  it('sets passwordHash when creating new staff with temporaryPassword', async () => {
    const { studio, token } = await ownerContext();
    const tempPassword = 'TempPass2026!';

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send(addStaffPayload({ temporaryPassword: tempPassword }))
      .expect(201);

    const body = res.body as { user: { email: string; passwordHash?: string } };
    expect(body.user.email).toBe('newstaff@e2e.local');
    expect(body.user.passwordHash).toBeUndefined();

    const stored = await prisma.user.findUnique({
      where: { email: 'newstaff@e2e.local' },
      select: { passwordHash: true },
    });
    expect(stored?.passwordHash).toBeTruthy();
  });

  it('allows created staff to log in with the temporary password', async () => {
    const { studio, token } = await ownerContext();
    const tempPassword = 'TempPass2026!';

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send(addStaffPayload({ temporaryPassword: tempPassword }))
      .expect(201);

    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'newstaff@e2e.local', password: tempPassword })
      .expect(201);

    expect((loginRes.body as { accessToken: string }).accessToken).toBeTruthy();
    expect((loginRes.body as { user: { passwordHash?: string } }).user.passwordHash).toBeUndefined();
  });

  it('sets passwordHash for an existing user without credentials', async () => {
    const { studio, token } = await ownerContext();
    const tempPassword = 'TempPass2026!';

    const existing = await prisma.user.create({
      data: {
        email: 'nopass@e2e.local',
        firstName: 'No',
        lastName: 'Password',
      },
      select: { id: true },
    });

    await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        addStaffPayload({
          email: 'nopass@e2e.local',
          firstName: undefined,
          lastName: undefined,
          temporaryPassword: tempPassword,
        }),
      )
      .expect(201);

    const stored = await prisma.user.findUnique({
      where: { id: existing.id },
      select: { passwordHash: true },
    });
    expect(stored?.passwordHash).toBeTruthy();

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nopass@e2e.local', password: tempPassword })
      .expect(201);
  });

  it('rejects temporaryPassword when the user already has login credentials', async () => {
    const { studio, token } = await ownerContext();

    const existing = await createUserWithPassword(prisma, {
      email: 'haspass@e2e.local',
      password: 'password12',
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        addStaffPayload({
          email: existing.email,
          firstName: undefined,
          lastName: undefined,
          temporaryPassword: 'AnotherPass1!',
        }),
      )
      .expect(400);

    expect((res.body as { message: string }).message).toBe(
      'This user already has login credentials.',
    );
  });

  it('links an existing credentialed user as staff when temporaryPassword is omitted', async () => {
    const { studio, token } = await ownerContext();

    const existing = await createUserWithPassword(prisma, {
      email: 'linked@e2e.local',
      password: 'password12',
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/studios/${studio.id}/staff`)
      .set('Authorization', `Bearer ${token}`)
      .send(
        addStaffPayload({
          email: existing.email,
          firstName: undefined,
          lastName: undefined,
          temporaryPassword: undefined,
        }),
      )
      .expect(201);

    expect((res.body as { userId: string }).userId).toBe(existing.id);

    const membership = await prisma.studioMembership.findFirst({
      where: { studioId: studio.id, userId: existing.id, deletedAt: null },
    });
    expect(membership?.role).toBe(Role.STAFF);
  });
});
