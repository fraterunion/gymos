import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Role, StaffType } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { StaffService } from './staff.service';
import type { AddStaffDto } from './dto/add-staff.dto';

describe('StaffService.addStaff passwords', () => {
  let service: StaffService;
  let prisma: {
    studioMembership: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    user: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    studioStaffProfile: { upsert: jest.Mock };
    scheduledClass: { count: jest.Mock };
  };
  let hashPassword: jest.Mock;

  const baseDto: AddStaffDto = {
    email: 'staff@example.com',
    firstName: 'Desk',
    lastName: 'Staff',
    role: Role.STAFF,
    staffType: StaffType.FRONT_DESK,
  };

  function mockMembershipRecord(userId: string) {
    prisma.studioMembership.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      if (args.where.userId === 'actor') {
        return { id: 'actor-membership', role: Role.OWNER };
      }
      if (args.where.id === 'membership-1') {
        return {
          id: 'membership-1',
          role: Role.STAFF,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          userId,
          user: {
            id: userId,
            email: 'staff@example.com',
            firstName: 'Desk',
            lastName: 'Staff',
            phone: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            staffProfiles: [],
          },
        };
      }
      return null;
    });
  }

  beforeEach(async () => {
    hashPassword = jest.fn().mockResolvedValue('hashed-password');
    prisma = {
      studioMembership: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'membership-1' }),
        update: jest.fn(),
      },
      user: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'user-1' }),
        update: jest.fn(),
      },
      studioStaffProfile: { upsert: jest.fn().mockResolvedValue({}) },
      scheduledClass: { count: jest.fn().mockResolvedValue(0) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaffService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthService, useValue: { hashPassword } },
      ],
    }).compile();

    service = module.get(StaffService);
    mockMembershipRecord('user-1');
  });

  it('requires temporaryPassword for a new staff account', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(service.addStaff('studio-1', 'actor', baseDto)).rejects.toThrow(
      new BadRequestException('Temporary password is required for new staff accounts.'),
    );
  });

  it('hashes and stores passwordHash when creating a new staff user', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await service.addStaff('studio-1', 'actor', {
      ...baseDto,
      temporaryPassword: 'TempPass2026!',
    });

    expect(hashPassword).toHaveBeenCalledWith('TempPass2026!');
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'staff@example.com',
          passwordHash: 'hashed-password',
        }),
      }),
    );
  });

  it('requires temporaryPassword for an existing user without credentials', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'user-existing', passwordHash: null });

    await expect(
      service.addStaff('studio-1', 'actor', {
        ...baseDto,
        firstName: undefined,
        lastName: undefined,
      }),
    ).rejects.toThrow(new BadRequestException('Temporary password is required for new staff accounts.'));
  });

  it('updates passwordHash for an existing user without credentials', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'user-existing', passwordHash: null });
    mockMembershipRecord('user-existing');

    await service.addStaff('studio-1', 'actor', {
      ...baseDto,
      firstName: undefined,
      lastName: undefined,
      temporaryPassword: 'TempPass2026!',
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-existing' },
      data: { passwordHash: 'hashed-password' },
    });
  });

  it('rejects temporaryPassword when the user already has login credentials', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'user-existing', passwordHash: 'existing-hash' });

    await expect(
      service.addStaff('studio-1', 'actor', {
        ...baseDto,
        firstName: undefined,
        lastName: undefined,
        temporaryPassword: 'AnotherPass1!',
      }),
    ).rejects.toThrow(new BadRequestException('This user already has login credentials.'));
  });

  it('links an existing credentialed user without changing passwordHash', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'user-existing', passwordHash: 'existing-hash' });
    mockMembershipRecord('user-existing');

    await service.addStaff('studio-1', 'actor', {
      ...baseDto,
      firstName: undefined,
      lastName: undefined,
    });

    expect(hashPassword).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

describe('StaffService.addStaff roles', () => {
  let service: StaffService;
  let prisma: {
    studioMembership: {
      findFirst: jest.Mock;
      create: jest.Mock;
    };
    user: { findFirst: jest.Mock; create: jest.Mock };
    studioStaffProfile: { upsert: jest.Mock };
    scheduledClass: { count: jest.Mock };
  };

  const instructorDto: AddStaffDto = {
    email: 'coach@example.com',
    firstName: 'Coach',
    lastName: 'Test',
    role: Role.INSTRUCTOR,
    staffType: StaffType.COACH,
    temporaryPassword: 'TempPass2026!',
  };

  beforeEach(async () => {
    prisma = {
      studioMembership: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'membership-1' }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'user-1' }),
      },
      studioStaffProfile: { upsert: jest.fn().mockResolvedValue({}) },
      scheduledClass: { count: jest.fn().mockResolvedValue(0) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaffService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthService, useValue: { hashPassword: jest.fn().mockResolvedValue('hashed') } },
      ],
    }).compile();

    service = module.get(StaffService);

    prisma.studioMembership.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      if (args.where.userId === 'owner') {
        return { id: 'owner-membership', role: Role.OWNER };
      }
      if (args.where.userId === 'admin') {
        return { id: 'admin-membership', role: Role.ADMIN };
      }
      if (args.where.id === 'membership-1') {
        return {
          id: 'membership-1',
          role: Role.INSTRUCTOR,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          userId: 'user-1',
          user: {
            id: 'user-1',
            email: 'coach@example.com',
            firstName: 'Coach',
            lastName: 'Test',
            phone: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            staffProfiles: [],
          },
        };
      }
      return null;
    });
  });

  it('allows OWNER to create INSTRUCTOR', async () => {
    await service.addStaff('studio-1', 'owner', instructorDto);

    expect(prisma.studioMembership.create).toHaveBeenCalledWith({
      data: { studioId: 'studio-1', userId: 'user-1', role: Role.INSTRUCTOR },
    });
  });

  it('allows ADMIN to create INSTRUCTOR', async () => {
    await service.addStaff('studio-1', 'admin', instructorDto);

    expect(prisma.studioMembership.create).toHaveBeenCalledWith({
      data: { studioId: 'studio-1', userId: 'user-1', role: Role.INSTRUCTOR },
    });
  });

  it('allows ADMIN to create ADMIN', async () => {
    await service.addStaff('studio-1', 'admin', {
      ...instructorDto,
      role: Role.ADMIN,
      staffType: StaffType.MANAGER,
    });

    expect(prisma.studioMembership.create).toHaveBeenCalledWith({
      data: { studioId: 'studio-1', userId: 'user-1', role: Role.ADMIN },
    });
  });

  it('denies ADMIN from creating OWNER', async () => {
    await expect(
      service.addStaff('studio-1', 'admin', {
        ...instructorDto,
        role: Role.OWNER,
        staffType: StaffType.MANAGER,
      }),
    ).rejects.toThrow('Insufficient permissions to manage this role');
  });
});

describe('StaffService.updateStaff', () => {
  let service: StaffService;
  let prisma: {
    studioMembership: {
      findFirst: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
    user: { findFirst: jest.Mock; update: jest.Mock };
    studioStaffProfile: { upsert: jest.Mock };
    scheduledClass: { count: jest.Mock };
  };
  let hashPassword: jest.Mock;

  beforeEach(async () => {
    hashPassword = jest.fn().mockResolvedValue('new-hash');
    prisma = {
      studioMembership: {
        findFirst: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      user: { findFirst: jest.fn(), update: jest.fn() },
      studioStaffProfile: { upsert: jest.fn().mockResolvedValue({}) },
      scheduledClass: { count: jest.fn().mockResolvedValue(0) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaffService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthService, useValue: { hashPassword } },
      ],
    }).compile();

    service = module.get(StaffService);
  });

  function mockActorAndTarget(targetRole: Role, targetUserId = 'target-user') {
    prisma.studioMembership.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      if (args.where.userId === 'owner') {
        return { id: 'owner-membership', role: Role.OWNER };
      }
      if (args.where.userId === targetUserId) {
        return { id: 'target-membership', role: targetRole, userId: targetUserId };
      }
      if (args.where.id === 'target-membership') {
        return {
          id: 'target-membership',
          role: targetRole,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          userId: targetUserId,
          user: {
            id: targetUserId,
            email: 'owner@example.com',
            firstName: 'Only',
            lastName: 'Owner',
            phone: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            staffProfiles: [],
          },
        };
      }
      return null;
    });
  }

  it('blocks deactivating the last studio owner', async () => {
    mockActorAndTarget(Role.OWNER);
    prisma.studioMembership.count.mockResolvedValue(1);

    await expect(
      service.updateStaff('studio-1', 'owner', 'target-user', { isActive: false }),
    ).rejects.toThrow(new BadRequestException('Cannot modify the last studio owner'));
  });

  it('hashes temporaryPassword on update', async () => {
    mockActorAndTarget(Role.STAFF);
    prisma.user.findFirst.mockResolvedValue(null);

    await service.updateStaff('studio-1', 'owner', 'target-user', {
      temporaryPassword: 'NewPass2026!',
    });

    expect(hashPassword).toHaveBeenCalledWith('NewPass2026!');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'target-user' },
      data: { passwordHash: 'new-hash' },
    });
  });
});

describe('StaffService.activate/deactivate', () => {
  let service: StaffService;
  let prisma: {
    studioMembership: { findFirst: jest.Mock; count: jest.Mock };
    studioStaffProfile: { upsert: jest.Mock };
    scheduledClass: { count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      studioMembership: { findFirst: jest.fn(), count: jest.fn() },
      studioStaffProfile: { upsert: jest.fn().mockResolvedValue({}) },
      scheduledClass: { count: jest.fn().mockResolvedValue(2) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StaffService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthService, useValue: { hashPassword: jest.fn() } },
      ],
    }).compile();

    service = module.get(StaffService);
  });

  it('activates staff via explicit endpoint', async () => {
    prisma.studioMembership.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      if (args.where.userId === 'admin') return { id: 'admin-m', role: Role.ADMIN };
      if (args.where.userId === 'target') return { id: 'target-m', role: Role.STAFF, userId: 'target' };
      return null;
    });

    const result = await service.activateStaff('studio-1', 'admin', 'target');

    expect(result).toEqual({ isActive: true });
    expect(prisma.studioStaffProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { isActive: true } }),
    );
  });

  it('denies ADMIN from deactivating OWNER', async () => {
    prisma.studioMembership.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      if (args.where.userId === 'admin') return { id: 'admin-m', role: Role.ADMIN };
      if (args.where.userId === 'owner-target') return { id: 'owner-m', role: Role.OWNER, userId: 'owner-target' };
      return null;
    });

    await expect(service.deactivateStaff('studio-1', 'admin', 'owner-target')).rejects.toThrow(
      'Insufficient permissions to manage this role',
    );
  });
});
