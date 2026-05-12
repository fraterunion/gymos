import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateMemberRoleDto } from './dto/update-member-role.dto';

const publicUserSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  async listMembers(studioId: string) {
    const rows = await this.prisma.studioMembership.findMany({
      where: {
        studioId,
        deletedAt: null,
        user: { deletedAt: null },
      },
      include: {
        user: { select: publicUserSelect },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((m) => ({
      membershipId: m.id,
      role: m.role,
      createdAt: m.createdAt,
      user: m.user,
    }));
  }

  async getMemberProfile(studioId: string, userId: string) {
    const membership = await this.prisma.studioMembership.findFirst({
      where: {
        studioId,
        userId,
        deletedAt: null,
        user: { deletedAt: null },
      },
      include: {
        user: { select: publicUserSelect },
      },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }

    const [attendanceTotal, activeSubscription] = await Promise.all([
      this.prisma.attendance.count({
        where: { studioId, userId },
      }),
      this.prisma.subscription.findFirst({
        where: {
          studioId,
          userId,
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
        },
        orderBy: { createdAt: 'desc' },
        include: {
          membershipPlan: {
            select: {
              id: true,
              name: true,
              billingInterval: true,
              priceCents: true,
              currency: true,
              classCredits: true,
            },
          },
        },
      }),
    ]);

    return {
      user: membership.user,
      role: membership.role,
      membership: {
        id: membership.id,
        createdAt: membership.createdAt,
        updatedAt: membership.updatedAt,
      },
      attendances: {
        totalInStudio: attendanceTotal,
      },
      activeSubscription: activeSubscription
        ? {
            id: activeSubscription.id,
            status: activeSubscription.status,
            currentPeriodStart: activeSubscription.currentPeriodStart,
            currentPeriodEnd: activeSubscription.currentPeriodEnd,
            cancelAtPeriodEnd: activeSubscription.cancelAtPeriodEnd,
            plan: activeSubscription.membershipPlan,
          }
        : null,
    };
  }

  async updateMemberRole(
    studioId: string,
    targetUserId: string,
    actorUserId: string,
    dto: UpdateMemberRoleDto,
  ) {
    if (targetUserId === actorUserId) {
      throw new BadRequestException('You cannot change your own role');
    }
    const membership = await this.prisma.studioMembership.findFirst({
      where: {
        studioId,
        userId: targetUserId,
        deletedAt: null,
        user: { deletedAt: null },
      },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
    return this.prisma.studioMembership.update({
      where: { id: membership.id },
      data: { role: dto.role },
      include: {
        user: { select: publicUserSelect },
      },
    });
  }
}
