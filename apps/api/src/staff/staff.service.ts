import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClassStatus, Prisma, Role, StaffType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AddStaffDto } from './dto/add-staff.dto';
import type { ListStaffQueryDto } from './dto/list-staff-query.dto';
import type { UpdateStaffDto } from './dto/update-staff.dto';

const STAFF_ROLES: Role[] = [Role.OWNER, Role.ADMIN, Role.STAFF, Role.INSTRUCTOR];

const userSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

const staffProfileSelect = {
  id: true,
  staffType: true,
  phone: true,
  bio: true,
  specialties: true,
  photoUrl: true,
  isActive: true,
} satisfies Prisma.StudioStaffProfileSelect;

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async getActorMembership(studioId: string, actorUserId: string) {
    const m = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId: actorUserId, deletedAt: null },
    });
    if (!m) throw new ForbiddenException();
    return m;
  }

  private assertCanManageRole(actorRole: Role, targetRole: Role): void {
    if (actorRole === Role.OWNER) return;
    if (actorRole === Role.ADMIN) {
      if (targetRole === Role.OWNER || targetRole === Role.ADMIN) {
        throw new ForbiddenException('Insufficient permissions to manage this role');
      }
      return;
    }
    throw new ForbiddenException('Insufficient permissions');
  }

  private async buildStaffRecord(studioId: string, membershipId: string) {
    const membership = await this.prisma.studioMembership.findFirst({
      where: { id: membershipId, studioId, deletedAt: null },
      select: {
        id: true,
        role: true,
        createdAt: true,
        userId: true,
        user: {
          select: {
            ...userSelect,
            staffProfiles: {
              where: { studioId },
              select: staffProfileSelect,
              take: 1,
            },
          },
        },
      },
    });
    if (!membership) throw new NotFoundException('Staff member not found');

    const { staffProfiles, ...userWithout } = membership.user;
    const futureClassesCount = await this.prisma.scheduledClass.count({
      where: {
        studioId,
        instructorId: membership.userId,
        startsAt: { gte: new Date() },
        status: ClassStatus.SCHEDULED,
      },
    });

    return {
      membershipId: membership.id,
      userId: membership.userId,
      role: membership.role,
      joinedAt: membership.createdAt,
      user: userWithout,
      staffProfile: staffProfiles[0] ?? null,
      assignedClassesCount: futureClassesCount,
    };
  }

  // ── List ───────────────────────────────────────────────────────────────────

  async listStaff(studioId: string, query: ListStaffQueryDto) {
    const { search, page = 1, limit = 50 } = query;

    const userWhere: Prisma.UserWhereInput = { deletedAt: null };
    if (search) {
      const s = search.trim();
      userWhere.OR = [
        { firstName: { contains: s, mode: 'insensitive' } },
        { lastName: { contains: s, mode: 'insensitive' } },
        { email: { contains: s, mode: 'insensitive' } },
      ];
    }

    const memberships = await this.prisma.studioMembership.findMany({
      where: {
        studioId,
        deletedAt: null,
        role: query.role ? query.role : { in: STAFF_ROLES },
        user: userWhere,
      },
      select: {
        id: true,
        role: true,
        createdAt: true,
        userId: true,
        user: {
          select: {
            ...userSelect,
            staffProfiles: {
              where: { studioId },
              select: staffProfileSelect,
              take: 1,
            },
          },
        },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });

    // In-memory filter for staffType / isActive (profile fields)
    let filtered = memberships;
    if (query.staffType !== undefined || query.isActive !== undefined) {
      filtered = memberships.filter((m) => {
        const profile = m.user.staffProfiles[0] ?? null;
        if (query.staffType !== undefined) {
          if (!profile || profile.staffType !== query.staffType) return false;
        }
        if (query.isActive !== undefined) {
          const active = profile ? profile.isActive : true;
          if (active !== query.isActive) return false;
        }
        return true;
      });
    }

    // Future assigned class counts
    const userIds = filtered.map((m) => m.userId).filter(Boolean);
    const assignedCounts =
      userIds.length > 0
        ? await this.prisma.scheduledClass.groupBy({
            by: ['instructorId'],
            where: {
              studioId,
              instructorId: { in: userIds },
              startsAt: { gte: new Date() },
              status: ClassStatus.SCHEDULED,
            },
            _count: { _all: true },
          })
        : [];
    const assignedMap = new Map(
      assignedCounts.map((r) => [r.instructorId!, r._count._all]),
    );

    const total = filtered.length;
    const start = (page - 1) * limit;
    const data = filtered.slice(start, start + limit).map((m) => {
      const { staffProfiles, ...userWithout } = m.user;
      return {
        membershipId: m.id,
        userId: m.userId,
        role: m.role,
        joinedAt: m.createdAt,
        user: userWithout,
        staffProfile: staffProfiles[0] ?? null,
        assignedClassesCount: assignedMap.get(m.userId) ?? 0,
      };
    });

    return { data, total, page, limit };
  }

  // ── Instructors (active staff for schedule dropdown) ──────────────────────

  async listInstructors(studioId: string) {
    const profiles = await this.prisma.studioStaffProfile.findMany({
      where: {
        studioId,
        isActive: true,
        user: {
          deletedAt: null,
          studioMemberships: {
            some: { studioId, deletedAt: null, role: { in: STAFF_ROLES } },
          },
        },
      },
      select: {
        userId: true,
        staffType: true,
        user: { select: { firstName: true, lastName: true } },
      },
      orderBy: [{ user: { firstName: 'asc' } }, { user: { lastName: 'asc' } }],
    });

    return profiles.map((p) => ({
      userId: p.userId,
      firstName: p.user.firstName,
      lastName: p.user.lastName,
      staffType: p.staffType,
    }));
  }

  // ── Single profile ─────────────────────────────────────────────────────────

  async getStaffMember(studioId: string, targetUserId: string) {
    const membership = await this.prisma.studioMembership.findFirst({
      where: {
        studioId,
        userId: targetUserId,
        deletedAt: null,
        role: { in: STAFF_ROLES },
        user: { deletedAt: null },
      },
      select: { id: true },
    });
    if (!membership) throw new NotFoundException('Staff member not found');
    return this.buildStaffRecord(studioId, membership.id);
  }

  // ── Add staff ──────────────────────────────────────────────────────────────

  async addStaff(studioId: string, actorUserId: string, dto: AddStaffDto) {
    const actorMembership = await this.getActorMembership(studioId, actorUserId);
    this.assertCanManageRole(actorMembership.role, dto.role);

    // Find or create user
    let user = await this.prisma.user.findFirst({
      where: { email: dto.email.toLowerCase(), deletedAt: null },
    });

    if (!user) {
      if (!dto.firstName || !dto.lastName) {
        throw new BadRequestException(
          'No user found with that email. Provide firstName and lastName to create one.',
        );
      }
      user = await this.prisma.user.create({
        data: {
          email: dto.email.toLowerCase(),
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone ?? null,
        },
      });
    }

    // Find or update membership
    const existingMembership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId: user.id },
    });

    let membershipId: string;

    if (existingMembership) {
      if (existingMembership.deletedAt) {
        // Restore soft-deleted membership
        const updated = await this.prisma.studioMembership.update({
          where: { id: existingMembership.id },
          data: { role: dto.role, deletedAt: null },
        });
        membershipId = updated.id;
      } else if (existingMembership.role === Role.MEMBER) {
        // Upgrade member to staff role
        const updated = await this.prisma.studioMembership.update({
          where: { id: existingMembership.id },
          data: { role: dto.role },
        });
        membershipId = updated.id;
      } else {
        // Check actor can manage existing role before potentially changing it
        this.assertCanManageRole(actorMembership.role, existingMembership.role);
        if (existingMembership.role !== dto.role) {
          await this.prisma.studioMembership.update({
            where: { id: existingMembership.id },
            data: { role: dto.role },
          });
        }
        membershipId = existingMembership.id;
      }
    } else {
      const created = await this.prisma.studioMembership.create({
        data: { studioId, userId: user.id, role: dto.role },
      });
      membershipId = created.id;
    }

    // Upsert staff profile
    await this.prisma.studioStaffProfile.upsert({
      where: { studioId_userId: { studioId, userId: user.id } },
      create: {
        studioId,
        userId: user.id,
        staffType: dto.staffType,
        phone: dto.phone ?? null,
        bio: dto.bio ?? null,
        specialties: dto.specialties ?? [],
        photoUrl: dto.photoUrl ?? null,
        isActive: dto.isActive ?? true,
      },
      update: {
        staffType: dto.staffType,
        phone: dto.phone ?? null,
        bio: dto.bio ?? null,
        specialties: dto.specialties ?? [],
        photoUrl: dto.photoUrl ?? null,
        isActive: dto.isActive ?? true,
      },
    });

    return this.buildStaffRecord(studioId, membershipId);
  }

  // ── Update staff ───────────────────────────────────────────────────────────

  async updateStaff(
    studioId: string,
    actorUserId: string,
    targetUserId: string,
    dto: UpdateStaffDto,
  ) {
    const actorMembership = await this.getActorMembership(studioId, actorUserId);

    const targetMembership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId: targetUserId, deletedAt: null },
    });
    if (!targetMembership || !STAFF_ROLES.includes(targetMembership.role)) {
      throw new NotFoundException('Staff member not found');
    }

    this.assertCanManageRole(actorMembership.role, targetMembership.role);

    if (dto.role !== undefined) {
      if (actorUserId === targetUserId) {
        throw new BadRequestException('You cannot change your own role');
      }
      this.assertCanManageRole(actorMembership.role, dto.role);
      await this.prisma.studioMembership.update({
        where: { id: targetMembership.id },
        data: { role: dto.role },
      });
    }

    const profileUpdate: Prisma.StudioStaffProfileUpdateInput = {};
    if (dto.staffType !== undefined) profileUpdate.staffType = dto.staffType;
    if (dto.phone !== undefined) profileUpdate.phone = dto.phone;
    if (dto.bio !== undefined) profileUpdate.bio = dto.bio;
    if (dto.specialties !== undefined) profileUpdate.specialties = dto.specialties;
    if (dto.photoUrl !== undefined) profileUpdate.photoUrl = dto.photoUrl;
    if (dto.isActive !== undefined) profileUpdate.isActive = dto.isActive;

    if (Object.keys(profileUpdate).length > 0) {
      await this.prisma.studioStaffProfile.upsert({
        where: { studioId_userId: { studioId, userId: targetUserId } },
        create: {
          studioId,
          userId: targetUserId,
          staffType: dto.staffType ?? StaffType.OTHER,
          phone: dto.phone ?? null,
          bio: dto.bio ?? null,
          specialties: dto.specialties ?? [],
          photoUrl: dto.photoUrl ?? null,
          isActive: dto.isActive ?? true,
        },
        update: profileUpdate,
      });
    }

    return this.buildStaffRecord(studioId, targetMembership.id);
  }

  // ── Deactivate staff ───────────────────────────────────────────────────────

  async deactivateStaff(studioId: string, actorUserId: string, targetUserId: string) {
    if (actorUserId === targetUserId) {
      throw new BadRequestException('You cannot deactivate yourself');
    }

    const actorMembership = await this.getActorMembership(studioId, actorUserId);

    const targetMembership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId: targetUserId, deletedAt: null },
    });
    if (!targetMembership || !STAFF_ROLES.includes(targetMembership.role)) {
      throw new NotFoundException('Staff member not found');
    }

    this.assertCanManageRole(actorMembership.role, targetMembership.role);

    const futureClassesCount = await this.prisma.scheduledClass.count({
      where: {
        studioId,
        instructorId: targetUserId,
        startsAt: { gte: new Date() },
        status: ClassStatus.SCHEDULED,
      },
    });

    await this.prisma.studioStaffProfile.upsert({
      where: { studioId_userId: { studioId, userId: targetUserId } },
      create: {
        studioId,
        userId: targetUserId,
        staffType: StaffType.OTHER,
        isActive: false,
      },
      update: { isActive: false },
    });

    return { deactivated: true, futureClassesCount };
  }
}
