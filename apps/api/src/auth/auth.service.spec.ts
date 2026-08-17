import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WaiverService } from '../waiver/waiver.service';
import { AuthService } from './auth.service';

function sha256(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex');
}

describe('AuthService', () => {
  let service: AuthService;
  let waiverService: {
    validateRegistrationWaiver: jest.Mock;
    createSelfAcceptanceInTx: jest.Mock;
  };
  let prisma: jest.Mocked<
    Pick<PrismaService, '$transaction' | 'user' | 'refreshToken' | 'studio' | 'studioMembership'>
  >;

  const jwtSignAsync = jest.fn().mockResolvedValue('access.jwt.token');
  const configGet = jest.fn((key: string, def?: string) => {
    const map: Record<string, string> = {
      JWT_REFRESH_TTL_DAYS: '30',
      BCRYPT_ROUNDS: '4',
    };
    return map[key] ?? def;
  });

  const safeUser = {
    id: 'user-1',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    phone: null,
    platformRole: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  /** Sets up prisma.$transaction to execute the callback synchronously
   *  with a minimal fake Prisma transaction client. */
  function setupSuccessfulTransaction() {
    const txUser = { ...safeUser };
    const txClient = {
      user: {
        create: jest.fn().mockResolvedValue(txUser),
      },
      studioMembership: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient),
    );
    return { txClient, txUser };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    waiverService = {
      validateRegistrationWaiver: jest.fn().mockResolvedValue(null),
      createSelfAcceptanceInTx: jest.fn().mockResolvedValue(undefined),
    };
    prisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
      } as unknown as PrismaService['user'],
      refreshToken: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      } as unknown as PrismaService['refreshToken'],
      studio: {
        findFirst: jest.fn(),
      } as unknown as PrismaService['studio'],
      studioMembership: {
        upsert: jest.fn(),
      } as unknown as PrismaService['studioMembership'],
      $transaction: jest.fn(),
    } as unknown as jest.Mocked<
      Pick<PrismaService, '$transaction' | 'user' | 'refreshToken' | 'studio' | 'studioMembership'>
    >;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { signAsync: jwtSignAsync } },
        { provide: ConfigService, useValue: { get: configGet } },
        { provide: WaiverService, useValue: waiverService },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  // ─── register ─────────────────────────────────────────────────────────────
  describe('register', () => {
    it('throws ConflictException when email exists', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'u1' });
      await expect(
        service.register({
          email: 'a@b.com',
          firstName: 'A',
          lastName: 'B',
          password: 'password12',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws BadRequestException when studioSlug does not match a studio', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(
        service.register({
          email: 'a@b.com',
          firstName: 'A',
          lastName: 'B',
          password: 'password12',
          studioSlug: 'missing',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('registers without studio attachment (no studioSlug)', async () => {
      // First call: email duplicate check → not found.
      // Second call: getSafeUser after create → return user.
      (prisma.user.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(safeUser);
      (prisma.user.create as jest.Mock).mockResolvedValue(safeUser);
      (prisma.refreshToken.create as jest.Mock).mockResolvedValue({});

      const result = await service.register({
        email: 'a@b.com',
        firstName: 'A',
        lastName: 'B',
        password: 'password12',
      });

      expect(result.accessToken).toBe('access.jwt.token');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // ── ATOMICITY TESTS ────────────────────────────────────────────────────

    it('[ATOMICITY] creates user, membership, and acceptance atomically in one transaction when waiver required', async () => {
      // Once for email check (null = not taken); thereafter getSafeUser returns user.
      (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue({ id: 'studio-1' });
      waiverService.validateRegistrationWaiver.mockResolvedValue({ waiverDocumentId: 'doc-1' });
      (prisma.refreshToken.create as jest.Mock).mockResolvedValue({});

      const { txClient } = setupSuccessfulTransaction();
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(safeUser);

      await service.register({
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        password: 'Password123',
        studioSlug: 'ares',
        waiverAccepted: true,
        waiverDocumentId: 'doc-1',
      });

      // validateRegistrationWaiver must be called BEFORE the transaction
      expect(waiverService.validateRegistrationWaiver.mock.invocationCallOrder[0])
        .toBeLessThan((prisma.$transaction as jest.Mock).mock.invocationCallOrder[0]);

      // All three operations must be inside the transaction
      expect(txClient.user.create).toHaveBeenCalled();
      expect(txClient.studioMembership.upsert).toHaveBeenCalled();
      expect(waiverService.createSelfAcceptanceInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          studioId: 'studio-1',
          waiverDocumentId: 'doc-1',
        }),
      );
    });

    it('[ATOMICITY] email remains reusable when createSelfAcceptanceInTx fails (full rollback)', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue({ id: 'studio-1' });
      waiverService.validateRegistrationWaiver.mockResolvedValue({ waiverDocumentId: 'doc-1' });

      // createSelfAcceptanceInTx throws → transaction rolls back → user NOT created
      waiverService.createSelfAcceptanceInTx.mockRejectedValue(
        new BadRequestException('La Carta Responsiva no fue encontrada.'),
      );

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          const txClient = {
            user: { create: jest.fn().mockResolvedValue({ id: 'user-1' }) },
            studioMembership: { upsert: jest.fn().mockResolvedValue({}) },
          };
          // The real Prisma transaction would roll back; our mock propagates the error
          return fn(txClient);
        },
      );

      await expect(
        service.register({
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
          password: 'Password123',
          studioSlug: 'ares',
          waiverAccepted: true,
          waiverDocumentId: 'doc-1',
        }),
      ).rejects.toThrow(BadRequestException);

      // Because we throw inside the transaction callback, the DB would roll back.
      // The outer issueAuthBundle must NOT be reached.
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('[ATOMICITY] no acceptance created when no waiver required (no studioSlug waiver)', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue({ id: 'studio-1' });
      waiverService.validateRegistrationWaiver.mockResolvedValue(null);
      (prisma.refreshToken.create as jest.Mock).mockResolvedValue({});

      const { txClient } = setupSuccessfulTransaction();
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(safeUser);

      await service.register({
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        password: 'Password123',
        studioSlug: 'ares',
      });

      expect(txClient.user.create).toHaveBeenCalled();
      expect(txClient.studioMembership.upsert).toHaveBeenCalled();
      expect(waiverService.createSelfAcceptanceInTx).not.toHaveBeenCalled();
    });

    // ── TOCTOU TESTS ───────────────────────────────────────────────────────

    it('[TOCTOU] passes the validated waiverDocumentId into transaction, not re-derived', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce(null);
      (prisma.studio.findFirst as jest.Mock).mockResolvedValue({ id: 'studio-1' });
      waiverService.validateRegistrationWaiver.mockResolvedValue({ waiverDocumentId: 'doc-validated' });
      (prisma.refreshToken.create as jest.Mock).mockResolvedValue({});

      const { txClient } = setupSuccessfulTransaction();
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(safeUser);

      await service.register({
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        password: 'Password123',
        studioSlug: 'ares',
        waiverAccepted: true,
        waiverDocumentId: 'doc-validated',
      });

      // Must use the ID from validateRegistrationWaiver, not re-query the DB for "current active"
      expect(waiverService.createSelfAcceptanceInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ waiverDocumentId: 'doc-validated' }),
      );
    });
  });

  // ─── login ────────────────────────────────────────────────────────────────
  describe('login', () => {
    it('throws when user is soft-deleted', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        passwordHash: 'h',
        deletedAt: new Date(),
      });
      await expect(
        service.login({ email: 'a@b.com', password: 'password12' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  // ─── refresh ──────────────────────────────────────────────────────────────
  describe('refresh', () => {
    it('revokes family and throws when CAS updateMany returns count 0', async () => {
      const raw = randomBytes(8).toString('hex');
      const tokenHash = sha256(raw);
      const familyId = 'fam-1';
      const userId = 'user-1';

      (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValue({
        id: 'rt1',
        userId,
        familyId,
        tokenHash,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
        user: { deletedAt: null, email: 'a@b.com' },
      });

      (prisma.$transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<boolean>) => {
        const tx = {
          refreshToken: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            create: jest.fn(),
          },
        };
        return fn(tx);
      });

      const revokeSpy = prisma.refreshToken.updateMany as jest.Mock;
      revokeSpy.mockResolvedValue({ count: 3 });

      await expect(service.refresh({ refreshToken: raw })).rejects.toBeInstanceOf(UnauthorizedException);

      expect(revokeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { familyId, userId },
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      );
    });

    it('throws on reuse when token already revoked', async () => {
      const raw = randomBytes(8).toString('hex');
      (prisma.refreshToken.findUnique as jest.Mock).mockResolvedValue({
        id: 'rt1',
        userId: 'u1',
        familyId: 'f1',
        tokenHash: sha256(raw),
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        user: { deletedAt: null, email: 'a@b.com' },
      });
      (prisma.refreshToken.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await expect(service.refresh({ refreshToken: raw })).rejects.toThrow(
        'Refresh token reuse detected',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
