import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from './roles.guard';

function mockContext(opts: { user?: { sub: string }; studioId?: string }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: opts.user,
        params: { studioId: opts.studioId ?? 's1' },
      }),
    }),
    getHandler: jest.fn(),
    getClass: jest.fn(),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let prisma: { studioMembership: { findUnique: jest.Mock } };

  beforeEach(async () => {
    reflector = { getAllAndOverride: jest.fn() };
    prisma = { studioMembership: { findUnique: jest.fn() } };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesGuard,
        { provide: Reflector, useValue: reflector },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    guard = module.get(RolesGuard);
  });

  it('allows when no roles metadata', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(mockContext({ user: { sub: 'u1' } }))).resolves.toBe(true);
  });

  it('throws Unauthorized without user', async () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    await expect(guard.canActivate(mockContext({ user: undefined }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('throws Forbidden when role insufficient', async () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    prisma.studioMembership.findUnique.mockResolvedValue({
      id: 'm1',
      deletedAt: null,
      role: Role.MEMBER,
    });
    await expect(guard.canActivate(mockContext({ user: { sub: 'u1' } }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows ADMIN when required', async () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    prisma.studioMembership.findUnique.mockResolvedValue({
      id: 'm1',
      deletedAt: null,
      role: Role.ADMIN,
    });
    await expect(guard.canActivate(mockContext({ user: { sub: 'u1' } }))).resolves.toBe(true);
  });
});
