import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

function sha256(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex');
}

describe('AuthService', () => {
  let service: AuthService;
  let prisma: jest.Mocked<Pick<PrismaService, '$transaction' | 'user' | 'refreshToken'>>;

  const jwtSignAsync = jest.fn().mockResolvedValue('access.jwt.token');
  const configGet = jest.fn((key: string, def?: string) => {
    const map: Record<string, string> = {
      JWT_REFRESH_TTL_DAYS: '30',
      BCRYPT_ROUNDS: '4',
    };
    return map[key] ?? def;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
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
      $transaction: jest.fn(),
    } as unknown as jest.Mocked<Pick<PrismaService, '$transaction' | 'user' | 'refreshToken'>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { signAsync: jwtSignAsync } },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get(AuthService);
  });

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
  });

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
