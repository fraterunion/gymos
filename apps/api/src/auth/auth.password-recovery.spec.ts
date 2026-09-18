import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { TransactionalEmailService } from '../email/transactional-email.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import { WaiverService } from '../waiver/waiver.service';
import {
  AuthService,
  MAX_RESET_REQUESTS_PER_WINDOW,
  PASSWORD_RESET_TOKEN_INVALID_MESSAGE,
  PASSWORD_RESET_TTL_MINUTES,
} from './auth.service';
import { PASSWORD_SAME_AS_CURRENT_MESSAGE } from './password-policy';

function sha256(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex');
}

/**
 * Password recovery unit coverage. Prisma is faked with an in-memory transaction client so
 * the ordering guarantees (claim token → set hash → invalidate siblings → revoke sessions)
 * are asserted directly, including the concurrency compare-and-set.
 */
describe('AuthService — password recovery', () => {
  let service: AuthService;
  /** Loose fake-Prisma shape: the tests assert on jest mocks, not on Prisma's types. */
  let prisma: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  let email: { sendPasswordReset: jest.Mock; resolveBrandingForUser: jest.Mock };
  let audit: { log: jest.Mock };
  let txCalls: string[];

  const CURRENT_PASSWORD = 'currentPass123';
  let currentHash: string;
  /** Flipped by the capability-gate tests below; every other test runs with it enabled. */
  let recoveryEnabled = true;

  const user = {
    id: 'user-1',
    email: 'member@example.com',
    firstName: 'Ana',
    deletedAt: null as Date | null,
  };

  beforeAll(async () => {
    currentHash = await bcrypt.hash(CURRENT_PASSWORD, 4);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    recoveryEnabled = true;
    txCalls = [];

    const tx = {
      user: {
        update: jest.fn(async () => {
          txCalls.push('user.update');
          return {};
        }),
      },
      passwordResetToken: {
        create: jest.fn(async () => {
          txCalls.push('resetToken.create');
          return {};
        }),
        updateMany: jest.fn(async (args: { data?: { consumedAt?: Date } }) => {
          txCalls.push(
            args.data?.consumedAt ? 'resetToken.consume' : 'resetToken.invalidateOthers',
          );
          return { count: args.data?.consumedAt ? 1 : 2 };
        }),
      },
      refreshToken: {
        updateMany: jest.fn(async () => {
          txCalls.push('refreshToken.revokeAll');
          return { count: 3 };
        }),
        create: jest.fn(async () => {
          txCalls.push('refreshToken.create');
          return {};
        }),
      },
    };

    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      refreshToken: { updateMany: jest.fn(), create: jest.fn() },
      passwordResetToken: {
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      studio: { findFirst: jest.fn() },
      studioMembership: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(tx)),
      __tx: tx,
    };

    email = {
      sendPasswordReset: jest.fn().mockResolvedValue({
        delivered: true,
        branding: { studioId: 'studio-1', studioSlug: 'gym', displayName: 'Gym' },
      }),
      resolveBrandingForUser: jest.fn().mockResolvedValue({ studioId: 'studio-1' }),
    };
    audit = { log: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { signAsync: jest.fn().mockResolvedValue('jwt') } },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string, d?: string) =>
              ({
                BCRYPT_ROUNDS: '4',
                JWT_REFRESH_TTL_DAYS: '30',
                PASSWORD_RECOVERY_ENABLED: recoveryEnabled ? 'true' : 'false',
              })[k] ?? d,
          },
        },
        { provide: WaiverService, useValue: {} },
        { provide: TransactionalEmailService, useValue: email },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  // ── forgot password ──────────────────────────────────────────────────────

  describe('requestPasswordReset', () => {
    it('stores only a HASH of the token and emails the plaintext', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash: currentHash });

      await service.requestPasswordReset({ email: user.email });

      const created = prisma.__tx.passwordResetToken.create.mock.calls[0][0].data;
      const sentToken = email.sendPasswordReset.mock.calls[0][0].token;
      expect(sentToken).toMatch(/^[0-9a-f]{64}$/);
      expect(created.tokenHash).toBe(sha256(sentToken));
      // The plaintext must not be recoverable from anything we persisted.
      expect(JSON.stringify(created)).not.toContain(sentToken);
    });

    it('expires the token about 30 minutes out', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash: currentHash });
      const before = Date.now();

      await service.requestPasswordReset({ email: user.email });

      const { expiresAt } = prisma.__tx.passwordResetToken.create.mock.calls[0][0].data;
      const deltaMinutes = (expiresAt.getTime() - before) / 60_000;
      expect(PASSWORD_RESET_TTL_MINUTES).toBe(30);
      expect(deltaMinutes).toBeGreaterThan(29);
      expect(deltaMinutes).toBeLessThanOrEqual(30.1);
    });

    it('invalidates previously issued tokens for that user', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash: currentHash });

      await service.requestPasswordReset({ email: user.email });

      expect(prisma.__tx.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { userId: user.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: expect.any(Date) },
      });
      // …and it happens before the new token is written, inside the same transaction.
      expect(txCalls).toEqual(['resetToken.invalidateOthers', 'resetToken.create']);
    });

    it('does nothing observable for an unknown email (no token, no mail, no audit)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.requestPasswordReset({ email: 'nobody@example.com' })).resolves.toBeUndefined();

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(email.sendPasswordReset).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('treats a soft-deleted user exactly like an unknown email', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, deletedAt: new Date(), passwordHash: currentHash });

      await service.requestPasswordReset({ email: user.email });

      expect(email.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('caps requests per account and stays silent when capped', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash: currentHash });
      prisma.passwordResetToken.count.mockResolvedValue(MAX_RESET_REQUESTS_PER_WINDOW);

      await expect(service.requestPasswordReset({ email: user.email })).resolves.toBeUndefined();

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(email.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('passes the studio hint through for branding only', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash: currentHash });
      prisma.studio.findFirst.mockResolvedValue({ id: 'studio-42' });

      await service.requestPasswordReset({ email: user.email, studioSlug: 'some-gym' });

      expect(email.sendPasswordReset).toHaveBeenCalledWith(
        expect.objectContaining({ hintedStudioId: 'studio-42' }),
      );
    });

    it('records PASSWORD_RESET_REQUESTED without any credential material', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash: currentHash });

      await service.requestPasswordReset({ email: user.email });

      const logged = audit.log.mock.calls[0][0];
      expect(logged).toMatchObject({
        studioId: 'studio-1',
        action: 'PASSWORD_RESET_REQUESTED',
        targetUserId: user.id,
      });
      expect(JSON.stringify(logged)).not.toContain(user.email);
    });
  });

  // ── reset password ───────────────────────────────────────────────────────

  describe('resetPassword', () => {
    const validRecord = {
      id: 'reset-1',
      userId: user.id,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      consumedAt: null as Date | null,
      invalidatedAt: null as Date | null,
      user: { id: user.id, deletedAt: null as Date | null },
    };

    it('looks the token up by hash, never by plaintext', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(validRecord);

      await service.resetPassword({ token: 'plain-token-value', newPassword: 'brandNewPass1' });

      expect(prisma.passwordResetToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: sha256('plain-token-value') } }),
      );
    });

    it('writes the new hash, consumes the token, kills siblings and revokes sessions in ONE transaction', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(validRecord);

      await service.resetPassword({ token: 'tok', newPassword: 'brandNewPass1' });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(txCalls).toEqual([
        'resetToken.consume',
        'user.update',
        'resetToken.invalidateOthers',
        'refreshToken.revokeAll',
      ]);
      const updated = prisma.__tx.user.update.mock.calls[0][0];
      expect(await bcrypt.compare('brandNewPass1', updated.data.passwordHash)).toBe(true);
      expect(prisma.__tx.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it.each([
      ['unknown token', null],
      ['already consumed', { ...validRecord, consumedAt: new Date() }],
      ['superseded by a newer request', { ...validRecord, invalidatedAt: new Date() }],
      ['expired', { ...validRecord, expiresAt: new Date(Date.now() - 1000) }],
      ['user since deleted', { ...validRecord, user: { id: user.id, deletedAt: new Date() } }],
    ])('rejects %s with one indistinguishable message and no writes', async (_label, record) => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(record);

      await expect(
        service.resetPassword({ token: 'tok', newPassword: 'brandNewPass1' }),
      ).rejects.toThrow(PASSWORD_RESET_TOKEN_INVALID_MESSAGE);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('cannot be replayed: a losing compare-and-set changes nothing', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(validRecord);
      // Simulate a concurrent request having consumed the row first.
      prisma.__tx.passwordResetToken.updateMany.mockImplementation(async () => ({ count: 0 }));

      await expect(
        service.resetPassword({ token: 'tok', newPassword: 'brandNewPass1' }),
      ).rejects.toThrow(PASSWORD_RESET_TOKEN_INVALID_MESSAGE);
      expect(prisma.__tx.user.update).not.toHaveBeenCalled();
      expect(prisma.__tx.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('enforces the shared password policy before touching the token', async () => {
      await expect(
        service.resetPassword({ token: 'tok', newPassword: 'short' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.passwordResetToken.findUnique).not.toHaveBeenCalled();
    });

    it('records PASSWORD_RESET_COMPLETED', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(validRecord);

      await service.resetPassword({ token: 'tok', newPassword: 'brandNewPass1' });

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PASSWORD_RESET_COMPLETED', targetUserId: user.id }),
      );
    });
  });

  // ── capability gate ──────────────────────────────────────────────────────

  describe('PASSWORD_RECOVERY_ENABLED gate', () => {
    beforeEach(() => {
      recoveryEnabled = false;
    });

    it('reports the capability so clients can hide the entry point', async () => {
      expect(service.isPasswordRecoveryEnabled()).toBe(false);
      recoveryEnabled = true;
      // The module is rebuilt per test; read through the same accessor the controller uses.
      const mod: TestingModule = await Test.createTestingModule({
        providers: [
          AuthService,
          { provide: PrismaService, useValue: prisma },
          { provide: JwtService, useValue: { signAsync: jest.fn() } },
          {
            provide: ConfigService,
            useValue: { get: (k: string, d?: string) => (k === 'PASSWORD_RECOVERY_ENABLED' ? 'true' : d) },
          },
          { provide: WaiverService, useValue: {} },
          { provide: TransactionalEmailService, useValue: email },
          { provide: AuditService, useValue: audit },
        ],
      }).compile();
      expect(mod.get(AuthService).isPasswordRecoveryEnabled()).toBe(true);
    });

    it('refuses forgot-password globally, identically for every address', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, passwordHash: currentHash });

      const real = await service
        .requestPasswordReset({ email: user.email })
        .catch((e: Error) => e);
      const unknown = await service
        .requestPasswordReset({ email: 'nobody@example.com' })
        .catch((e: Error) => e);

      // Same refusal either way — the gate cannot be used to probe for accounts.
      expect((real as Error).message).toBe((unknown as Error).message);
      expect(real).toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(email.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('refuses reset-password and never consumes a token', async () => {
      await expect(
        service.resetPassword({ token: 'tok', newPassword: 'brandNewPass1' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.passwordResetToken.findUnique).not.toHaveBeenCalled();
    });

    it('still allows an authenticated password change (it needs no email)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: user.id,
        email: user.email,
        passwordHash: currentHash,
        deletedAt: null,
        firstName: 'Ana',
        lastName: 'User',
        phone: null,
        platformRole: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expect(
        service.changePassword(user.id, {
          currentPassword: CURRENT_PASSWORD,
          newPassword: 'aBrandNewPass1',
        }),
      ).resolves.toMatchObject({ accessToken: 'jwt' });
    });
  });

  // ── change password ──────────────────────────────────────────────────────

  describe('changePassword', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({
        id: user.id,
        email: user.email,
        passwordHash: currentHash,
        deletedAt: null,
        firstName: 'Ana',
        lastName: 'User',
        phone: null,
        platformRole: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    it('changes the password and returns a fresh session', async () => {
      const bundle = await service.changePassword(user.id, {
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'aBrandNewPass1',
      });

      const updated = prisma.__tx.user.update.mock.calls[0][0];
      expect(await bcrypt.compare('aBrandNewPass1', updated.data.passwordHash)).toBe(true);
      expect(bundle.accessToken).toBe('jwt');
      expect(bundle.refreshToken).toMatch(/^[0-9a-f]{128}$/);
    });

    it('revokes every existing session and issues the replacement in the same transaction', async () => {
      await service.changePassword(user.id, {
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'aBrandNewPass1',
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(txCalls).toEqual([
        'user.update',
        'refreshToken.revokeAll',
        'resetToken.invalidateOthers',
        'refreshToken.create',
      ]);
    });

    it('rejects a wrong current password without writing anything', async () => {
      await expect(
        service.changePassword(user.id, { currentPassword: 'nope', newPassword: 'aBrandNewPass1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a new password that fails the shared policy', async () => {
      await expect(
        service.changePassword(user.id, { currentPassword: CURRENT_PASSWORD, newPassword: 'short' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects reusing the current password', async () => {
      await expect(
        service.changePassword(user.id, {
          currentPassword: CURRENT_PASSWORD,
          newPassword: CURRENT_PASSWORD,
        }),
      ).rejects.toThrow(PASSWORD_SAME_AS_CURRENT_MESSAGE);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('invalidates outstanding reset links so an old email cannot undo the change', async () => {
      await service.changePassword(user.id, {
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'aBrandNewPass1',
      });

      expect(prisma.__tx.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { userId: user.id, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: expect.any(Date) },
      });
    });

    it('records PASSWORD_CHANGED', async () => {
      await service.changePassword(user.id, {
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'aBrandNewPass1',
      });

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PASSWORD_CHANGED', targetUserId: user.id }),
      );
    });

    it('never lets an audit failure block the user regaining control', async () => {
      audit.log.mockRejectedValue(new Error('audit down'));

      await expect(
        service.changePassword(user.id, {
          currentPassword: CURRENT_PASSWORD,
          newPassword: 'aBrandNewPass1',
        }),
      ).resolves.toMatchObject({ accessToken: 'jwt' });
    });
  });
});
