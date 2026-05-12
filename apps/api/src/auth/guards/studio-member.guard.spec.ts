import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { StudioMemberGuard } from './studio-member.guard';

function mockContext(partial: {
  user?: { sub: string; email: string } | undefined;
  studioId?: string;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: partial.user,
        params: { studioId: partial.studioId ?? 'studio-1' },
      }),
    }),
    getHandler: jest.fn(),
    getClass: jest.fn(),
  } as unknown as ExecutionContext;
}

describe('StudioMemberGuard', () => {
  let guard: StudioMemberGuard;
  let prisma: { user: { findUnique: jest.Mock }; studioMembership: { findUnique: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn() },
      studioMembership: { findUnique: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [StudioMemberGuard, { provide: PrismaService, useValue: prisma }],
    }).compile();
    guard = module.get(StudioMemberGuard);
  });

  it('throws Unauthorized when user missing', async () => {
    await expect(guard.canActivate(mockContext({ user: undefined }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws Forbidden when studioId missing', async () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: 'u1', email: 'a@b.com' },
          params: {},
        }),
      }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws when membership is soft-deleted', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', deletedAt: null });
    prisma.studioMembership.findUnique.mockResolvedValue({
      id: 'm1',
      deletedAt: new Date(),
      role: 'MEMBER',
    });
    await expect(
      guard.canActivate(mockContext({ user: { sub: 'u1', email: 'a@b.com' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns true for active member', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', deletedAt: null });
    prisma.studioMembership.findUnique.mockResolvedValue({
      id: 'm1',
      deletedAt: null,
      role: 'MEMBER',
    });
    await expect(
      guard.canActivate(mockContext({ user: { sub: 'u1', email: 'a@b.com' } })),
    ).resolves.toBe(true);
  });
});
