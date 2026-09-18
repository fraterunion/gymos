import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { EMAIL_PROVIDER, type EmailMessage, type EmailProvider } from '../src/email/email-provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import { createMembership, createStudio, createUserWithPassword } from './helpers/factories';

/**
 * Password recovery over real HTTP against the real database.
 *
 * No email leaves the process: with no provider configured the platform falls back to the
 * suppressing provider, and this suite additionally spies on it to read what WOULD have
 * been sent (the only place the plaintext token ever exists).
 */

const GENERIC_FORGOT_MESSAGE =
  'Si existe una cuenta asociada a este correo, recibirás instrucciones para restablecer tu contraseña.';

function sha256(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex');
}

function tokenFromEmail(message: EmailMessage): string {
  const match = message.text.match(/token=([0-9a-f]+)/);
  if (!match) throw new Error('reset email carried no token');
  return match[1]!;
}

describe('Password recovery (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sendSpy: jest.SpyInstance;

  const api = () => request(app.getHttpServer());

  /**
   * The route carries a real per-IP throttle, so every test presents its own client IP
   * (the app runs with `trust proxy`). That keeps tests independent while leaving the
   * throttle genuinely enabled — the rate-limit test below asserts it by reusing one IP.
   */
  let ipCounter = 0;
  function freshIp(): string {
    ipCounter += 1;
    return `203.0.113.${ipCounter % 250 || 1}`;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    const provider = app.get<EmailProvider>(EMAIL_PROVIDER);
    sendSpy = jest.spyOn(provider, 'send');
  });

  afterAll(async () => {
    sendSpy.mockRestore();
    await truncateAll(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    sendSpy.mockClear();
  });

  async function seedMember(opts: { email?: string; password?: string } = {}) {
    const studio = await createStudio(prisma);
    const user = await createUserWithPassword(prisma, {
      email: opts.email ?? 'recovery@e2e.local',
      password: opts.password ?? 'password12',
    });
    await createMembership(prisma, user.id, studio.id, Role.MEMBER);
    return { studio, user };
  }

  async function requestReset(email: string, studioSlug?: string, ip = freshIp()) {
    const res = await api()
      .post('/api/v1/auth/forgot-password')
      .set('X-Forwarded-For', ip)
      .send({ email, ...(studioSlug ? { studioSlug } : {}) })
      .expect(200);
    return res.body as { message: string };
  }

  /** reset-password and change-password carry their own per-IP throttles; give each call
   *  its own client IP so tests stay independent while the throttles stay enforced. */
  function postReset(body: Record<string, unknown>) {
    return api()
      .post('/api/v1/auth/reset-password')
      .set('X-Forwarded-For', freshIp())
      .send(body);
  }

  function postChangePassword(accessToken: string, body: Record<string, unknown>) {
    return api()
      .post('/api/v1/auth/change-password')
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  async function lastEmail(): Promise<EmailMessage> {
    const call = sendSpy.mock.calls.at(-1);
    if (!call) throw new Error('no email dispatched');
    return call[0] as EmailMessage;
  }

  // ── forgot password ──────────────────────────────────────────────────────

  it('returns the generic message for a real account and stores a HASHED token', async () => {
    const { user } = await seedMember();

    const body = await requestReset(user.email);
    expect(body).toEqual({ message: GENERIC_FORGOT_MESSAGE });

    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);

    const token = tokenFromEmail(await lastEmail());
    expect(rows[0]!.tokenHash).toBe(sha256(token));
    // The plaintext must exist nowhere in the row.
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0]!.consumedAt).toBeNull();
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns the SAME response for an unknown email and creates nothing', async () => {
    const real = await seedMember();
    const known = await requestReset(real.user.email);
    sendSpy.mockClear();

    const unknown = await requestReset('definitely-not-a-user@e2e.local');

    expect(unknown).toEqual(known);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await prisma.passwordResetToken.count()).toBe(1);
  });

  it('invalidates the previous link when a new one is requested', async () => {
    const { user } = await seedMember();
    await requestReset(user.email);
    const firstToken = tokenFromEmail(await lastEmail());

    await requestReset(user.email);
    const secondToken = tokenFromEmail(await lastEmail());
    expect(secondToken).not.toBe(firstToken);

    const first = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(firstToken) } });
    expect(first!.invalidatedAt).not.toBeNull();

    // The old link is dead even though it has not expired.
    await postReset({ token: firstToken, newPassword: 'newPassword123' })
      .expect(400);
    // The new one still works.
    await postReset({ token: secondToken, newPassword: 'newPassword123' })
      .expect(200);
  });

  it('throttles repeated requests from one client with 429 (per-IP route limit)', async () => {
    const { user } = await seedMember();
    const ip = '198.51.100.7';

    for (let i = 0; i < 5; i += 1) {
      await requestReset(user.email, undefined, ip);
    }
    await api()
      .post('/api/v1/auth/forgot-password')
      .set('X-Forwarded-For', ip)
      .send({ email: user.email })
      .expect(429);
  });

  it('caps requests per ACCOUNT even from different clients, with an unchanged response', async () => {
    const { user } = await seedMember();

    const bodies: unknown[] = [];
    for (let i = 0; i < 6; i += 1) {
      // A different source IP each time: only the per-account cap can stop this.
      bodies.push(await requestReset(user.email));
    }

    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    // Capped at 5 per window: the 6th produced no token and no email.
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(5);
    expect(sendSpy).toHaveBeenCalledTimes(5);
  });

  // ── white-label branding ─────────────────────────────────────────────────

  it('brands the email from the studio, with no platform hardcoding', async () => {
    const studio = await createStudio(prisma);
    await prisma.studio.update({
      where: { id: studio.id },
      data: {
        appDisplayName: 'Nordic Lifting Club',
        primaryColor: '#22AA55',
        logoUrl: 'https://cdn.e2e.local/nordic.png',
        supportEmail: 'ayuda@nordic.e2e.local',
      },
    });
    const user = await createUserWithPassword(prisma, { email: 'nordic@e2e.local' });
    await createMembership(prisma, user.id, studio.id, Role.MEMBER);

    await requestReset(user.email);
    const mail = await lastEmail();

    expect(mail.subject).toBe('Restablece tu contraseña de Nordic Lifting Club');
    expect(mail.from.name).toBe('Nordic Lifting Club');
    expect(mail.html).toContain('#22AA55');
    expect(mail.html).toContain('https://cdn.e2e.local/nordic.png');
    expect(mail.replyTo).toBe('ayuda@nordic.e2e.local');
    expect(mail.text).toMatch(/reset-password\?token=[0-9a-f]+/);
  });

  it('falls back to neutral platform branding for a user with no studio', async () => {
    const user = await createUserWithPassword(prisma, { email: 'solo@e2e.local' });

    await requestReset(user.email);
    const mail = await lastEmail();

    expect(mail.subject).toContain('GymOS');
    expect(mail.tags).toMatchObject({ type: 'password_reset', studio: 'platform' });
  });

  it('uses the hinted studio only when the user belongs to it', async () => {
    const home = await createStudio(prisma, { slug: 'home-gym' });
    const other = await createStudio(prisma, { slug: 'other-gym' });
    await prisma.studio.update({ where: { id: home.id }, data: { appDisplayName: 'Home Gym' } });
    await prisma.studio.update({ where: { id: other.id }, data: { appDisplayName: 'Other Gym' } });
    const user = await createUserWithPassword(prisma, { email: 'hinted@e2e.local' });
    await createMembership(prisma, user.id, home.id, Role.MEMBER);

    // Hint naming a studio the user does NOT belong to must not brand (or leak) anything.
    await requestReset(user.email, 'other-gym');
    expect((await lastEmail()).subject).toContain('Home Gym');
  });

  // ── reset password ───────────────────────────────────────────────────────

  it('resets the password, revokes every session and consumes the token', async () => {
    const { user } = await seedMember({ password: 'password12' });
    const session = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'password12' })
      .expect(201);
    const oldRefresh = session.body.refreshToken as string;

    await requestReset(user.email);
    const token = tokenFromEmail(await lastEmail());

    await postReset({ token, newPassword: 'brandNewPass1' })
      .expect(200);

    // Old password no longer works; new one does.
    await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'password12' })
      .expect(401);
    await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'brandNewPass1' })
      .expect(201);

    // Pre-existing session is dead.
    await api().post('/api/v1/auth/refresh').send({ refreshToken: oldRefresh }).expect(401);

    const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    expect(row!.consumedAt).not.toBeNull();
    const live = await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } });
    expect(live).toBe(1); // only the session created by the post-reset login
  });

  it('cannot reuse a consumed token', async () => {
    const { user } = await seedMember();
    await requestReset(user.email);
    const token = tokenFromEmail(await lastEmail());

    await api().post('/api/v1/auth/reset-password').send({ token, newPassword: 'firstNewPass1' }).expect(200);
    const replay = await postReset({ token, newPassword: 'secondNewPass1' })
      .expect(400);

    // The replay must not have changed the password again.
    await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'firstNewPass1' })
      .expect(201);
    expect(replay.body.message).not.toMatch(/consumed|expired|used/i);
  });

  it('rejects an expired token with the same message as an unknown one', async () => {
    const { user } = await seedMember();
    await requestReset(user.email);
    const token = tokenFromEmail(await lastEmail());
    await prisma.passwordResetToken.update({
      where: { tokenHash: sha256(token) },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const expired = await postReset({ token, newPassword: 'brandNewPass1' })
      .expect(400);
    const unknown = await postReset({ token: 'f'.repeat(64), newPassword: 'brandNewPass1' })
      .expect(400);

    expect(expired.body.message).toBe(unknown.body.message);
  });

  it('rejects a weak new password and leaves the token usable', async () => {
    const { user } = await seedMember();
    await requestReset(user.email);
    const token = tokenFromEmail(await lastEmail());

    await api().post('/api/v1/auth/reset-password').send({ token, newPassword: 'short' }).expect(400);

    const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    expect(row!.consumedAt).toBeNull();
    await postReset({ token, newPassword: 'brandNewPass1' })
      .expect(200);
  });

  // ── change password ──────────────────────────────────────────────────────

  async function loginTokens(email: string, password: string) {
    const res = await api().post('/api/v1/auth/login').send({ email, password }).expect(201);
    return res.body as { accessToken: string; refreshToken: string };
  }

  it('changes the password, keeps this device usable and signs other devices out', async () => {
    const { user } = await seedMember({ password: 'password12' });
    const deviceA = await loginTokens(user.email, 'password12');
    const deviceB = await loginTokens(user.email, 'password12');

    const res = await postChangePassword(deviceA.accessToken, {
      currentPassword: 'password12',
      newPassword: 'brandNewPass1',
    }).expect(200);

    // This device gets fresh credentials back and they work.
    expect(res.body.accessToken).toBeDefined();
    await api().post('/api/v1/auth/refresh').send({ refreshToken: res.body.refreshToken }).expect(201);
    // The other device is signed out.
    await api().post('/api/v1/auth/refresh').send({ refreshToken: deviceB.refreshToken }).expect(401);
    // Old refresh token of this very device is revoked too.
    await api().post('/api/v1/auth/refresh').send({ refreshToken: deviceA.refreshToken }).expect(401);

    await api().post('/api/v1/auth/login').send({ email: user.email, password: 'brandNewPass1' }).expect(201);
  });

  it('rejects a wrong current password', async () => {
    const { user } = await seedMember({ password: 'password12' });
    const tokens = await loginTokens(user.email, 'password12');

    await postChangePassword(tokens.accessToken, {
      currentPassword: 'wrongCurrent1',
      newPassword: 'brandNewPass1',
    }).expect(401);

    await api().post('/api/v1/auth/login').send({ email: user.email, password: 'password12' }).expect(201);
  });

  it('rejects a weak new password and reusing the current one', async () => {
    const { user } = await seedMember({ password: 'password12' });
    const tokens = await loginTokens(user.email, 'password12');

    await postChangePassword(tokens.accessToken, {
      currentPassword: 'password12',
      newPassword: 'short',
    }).expect(400);
    const same = await postChangePassword(tokens.accessToken, {
      currentPassword: 'password12',
      newPassword: 'password12',
    }).expect(400);
    expect(same.body.message).toMatch(/diferente/i);
  });

  it('requires authentication', async () => {
    await api()
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'password12', newPassword: 'brandNewPass1' })
      .expect(401);
  });

  // ── capability gate ──────────────────────────────────────────────────────

  it('advertises the capability publicly so clients can hide a disabled feature', async () => {
    const res = await api().get('/api/v1/auth/capabilities').expect(200);
    // e2e runs with NODE_ENV=test, where recovery defaults ON against the suppressing provider.
    expect(res.body).toEqual({ passwordRecoveryEnabled: true });
  });

  describe('with recovery switched off', () => {
    // ConfigService snapshots the validated config at boot (that is the production
    // behaviour we want), so the capability is flipped through the service accessor the
    // guard and the controller both read.
    let gateSpy: jest.SpyInstance;

    beforeEach(() => {
      gateSpy = jest
        .spyOn(app.get(AuthService), 'isPasswordRecoveryEnabled')
        .mockReturnValue(false);
    });
    afterEach(() => {
      gateSpy.mockRestore();
    });

    it('refuses forgot-password identically for real and unknown addresses', async () => {
      const { user } = await seedMember();

      const real = await api()
        .post('/api/v1/auth/forgot-password')
        .set('X-Forwarded-For', freshIp())
        .send({ email: user.email })
        .expect(503);
      const unknown = await api()
        .post('/api/v1/auth/forgot-password')
        .set('X-Forwarded-For', freshIp())
        .send({ email: 'nobody-at-all@e2e.local' })
        .expect(503);

      // Still enumeration-safe: the refusal is global, not account-dependent.
      expect(real.body.message).toBe(unknown.body.message);
      expect(await prisma.passwordResetToken.count()).toBe(0);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('refuses reset-password too', async () => {
      await postReset({ token: 'f'.repeat(64), newPassword: 'brandNewPass1' })
        .expect(503);
    });

    it('still allows an authenticated password change (no email involved)', async () => {
      const { user } = await seedMember({ password: 'password12' });
      const tokens = await loginTokens(user.email, 'password12');

      await postChangePassword(tokens.accessToken, {
        currentPassword: 'password12',
        newPassword: 'brandNewPass1',
      }).expect(200);
    });

    it('reports the capability as false', async () => {
      const res = await api().get('/api/v1/auth/capabilities').expect(200);
      expect(res.body).toEqual({ passwordRecoveryEnabled: false });
    });
  });

  // ── audit ────────────────────────────────────────────────────────────────

  it('writes studio-scoped security audit events without credential material', async () => {
    const { studio, user } = await seedMember({ password: 'password12' });

    await requestReset(user.email);
    const token = tokenFromEmail(await lastEmail());
    await api().post('/api/v1/auth/reset-password').send({ token, newPassword: 'brandNewPass1' }).expect(200);
    const tokens = await loginTokens(user.email, 'brandNewPass1');
    await postChangePassword(tokens.accessToken, {
      currentPassword: 'brandNewPass1',
      newPassword: 'thirdPassword1',
    }).expect(200);

    const logs = await prisma.auditLog.findMany({
      where: { studioId: studio.id, targetUserId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs.map((l) => l.action)).toEqual([
      'PASSWORD_RESET_REQUESTED',
      'PASSWORD_RESET_COMPLETED',
      'PASSWORD_CHANGED',
    ]);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('brandNewPass1');
    expect(serialized).not.toContain('$2b$');
  });
});
