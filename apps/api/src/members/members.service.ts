import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingStatus,
  CancelSource,
  CheckInMethod,
  ClassStatus,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { acquireBookingClassAdvisoryLock } from '../booking-class-advisory-lock';
import { PrismaService } from '../prisma/prisma.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import type { ListMembersQueryDto } from './dto/list-members-query.dto';
import type { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import type { UpdateSubscriptionStatusDto } from './dto/update-subscription-status.dto';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly waitlistService: WaitlistService,
  ) {}

  // ── Simple list (legacy — kept for compatibility) ──────────────────────────

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

  // ── Enriched list for CRM directory ───────────────────────────────────────

  async listMembersEnriched(studioId: string, query: ListMembersQueryDto) {
    const {
      search,
      sortBy = 'joinDate',
      sortDir = 'desc',
      page = 1,
      limit = 50,
    } = query;

    const userFilter: Prisma.UserWhereInput = { deletedAt: null };

    if (search) {
      const s = search.trim();
      userFilter.OR = [
        { firstName: { contains: s, mode: 'insensitive' } },
        { lastName: { contains: s, mode: 'insensitive' } },
        { email: { contains: s, mode: 'insensitive' } },
      ];
    }

    const where: Prisma.StudioMembershipWhereInput = {
      studioId,
      deletedAt: null,
      user: userFilter,
    };

    let orderBy: Prisma.StudioMembershipOrderByWithRelationInput[] = [];
    if (sortBy === 'name') {
      orderBy = [{ user: { firstName: sortDir } }, { user: { lastName: sortDir } }];
    } else if (sortBy === 'joinDate') {
      orderBy = [{ createdAt: sortDir }];
    }

    const memberships = await this.prisma.studioMembership.findMany({
      where,
      include: { user: { select: publicUserSelect } },
      orderBy: orderBy.length > 0 ? orderBy : [{ createdAt: 'desc' }],
    });

    if (memberships.length === 0) {
      return { data: [], total: 0, page, limit };
    }

    const userIds = memberships.map((m) => m.userId);

    const [bookingCounts, lastAttendances, subscriptions] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ['userId'],
        where: {
          studioId,
          userId: { in: userIds },
          status: { not: BookingStatus.CANCELLED },
        },
        _count: { _all: true },
      }),
      this.prisma.attendance.groupBy({
        by: ['userId'],
        where: { studioId, userId: { in: userIds } },
        _max: { checkedInAt: true },
      }),
      this.prisma.subscription.findMany({
        where: { studioId, userId: { in: userIds } },
        include: {
          membershipPlan: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const bookingCountMap = new Map(bookingCounts.map((r) => [r.userId, r._count._all]));
    const lastAttendanceMap = new Map(lastAttendances.map((r) => [r.userId, r._max.checkedInAt]));

    const subMap = new Map<string, (typeof subscriptions)[0]>();
    for (const sub of subscriptions) {
      if (!subMap.has(sub.userId)) subMap.set(sub.userId, sub);
    }

    let enriched = memberships.map((m) => {
      const sub = subMap.get(m.userId);
      return {
        membershipId: m.id,
        role: m.role,
        joinedAt: m.createdAt,
        user: m.user,
        totalBookings: bookingCountMap.get(m.userId) ?? 0,
        lastAttendanceAt: lastAttendanceMap.get(m.userId) ?? null,
        subscription: sub
          ? {
              id: sub.id,
              status: sub.status,
              planName: sub.membershipPlan.name,
              planId: sub.membershipPlan.id,
              currentPeriodEnd: sub.currentPeriodEnd,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            }
          : null,
      };
    });

    if (query.subStatus) {
      enriched = enriched.filter(
        (m) => m.subscription?.status === query.subStatus,
      );
    }

    if (sortBy === 'totalBookings') {
      enriched.sort((a, b) =>
        sortDir === 'asc'
          ? a.totalBookings - b.totalBookings
          : b.totalBookings - a.totalBookings,
      );
    } else if (sortBy === 'lastAttendance') {
      enriched.sort((a, b) => {
        const at = a.lastAttendanceAt?.getTime() ?? 0;
        const bt = b.lastAttendanceAt?.getTime() ?? 0;
        return sortDir === 'asc' ? at - bt : bt - at;
      });
    }

    const total = enriched.length;
    const start = (page - 1) * limit;
    const data = enriched.slice(start, start + limit);

    return { data, total, page, limit };
  }

  // ── Profile ────────────────────────────────────────────────────────────────

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

  // ── Paginated member sub-resources ────────────────────────────────────────

  async getMemberBookings(
    studioId: string,
    userId: string,
    page: number,
    limit: number,
  ) {
    await this.assertMembership(studioId, userId);
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.booking.findMany({
        where: { studioId, userId },
        include: {
          scheduledClass: {
            include: {
              classTemplate: { select: { id: true, name: true, color: true } },
              instructor: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
        orderBy: { scheduledClass: { startsAt: 'desc' } },
        skip,
        take: limit,
      }),
      this.prisma.booking.count({ where: { studioId, userId } }),
    ]);
    return { data, total, page, limit };
  }

  async getMemberAttendance(
    studioId: string,
    userId: string,
    page: number,
    limit: number,
  ) {
    await this.assertMembership(studioId, userId);
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.attendance.findMany({
        where: { studioId, userId },
        include: {
          scheduledClass: {
            include: {
              classTemplate: { select: { id: true, name: true, color: true } },
            },
          },
        },
        orderBy: { checkedInAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.attendance.count({ where: { studioId, userId } }),
    ]);
    return { data, total, page, limit };
  }

  async getMemberPayments(
    studioId: string,
    userId: string,
    page: number,
    limit: number,
  ) {
    await this.assertMembership(studioId, userId);
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.payment.findMany({
        where: { studioId, userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.payment.count({ where: { studioId, userId } }),
    ]);
    return { data, total, page, limit };
  }

  async getMemberSubscriptions(studioId: string, userId: string) {
    await this.assertMembership(studioId, userId);
    return this.prisma.subscription.findMany({
      where: { studioId, userId },
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
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Staff booking operations ───────────────────────────────────────────────

  async staffCreateBooking(
    studioId: string,
    targetUserId: string,
    scheduledClassId: string,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        await acquireBookingClassAdvisoryLock(tx, scheduledClassId);

        const [membership, scheduledClass] = await Promise.all([
          tx.studioMembership.findFirst({
            where: { studioId, userId: targetUserId, deletedAt: null },
            include: { user: { select: { deletedAt: true } } },
          }),
          tx.scheduledClass.findFirst({
            where: { id: scheduledClassId, studioId },
          }),
        ]);

        if (!membership || membership.user.deletedAt) {
          throw new NotFoundException('Member not found');
        }
        if (!scheduledClass) {
          throw new NotFoundException('Class not found');
        }
        if (scheduledClass.status !== ClassStatus.SCHEDULED) {
          throw new ConflictException('This class is not open for booking');
        }

        const confirmedCount = await tx.booking.count({
          where: { scheduledClassId, status: BookingStatus.CONFIRMED },
        });
        if (confirmedCount >= scheduledClass.capacity) {
          throw new ConflictException('Class is full');
        }

        try {
          return await tx.booking.create({
            data: {
              studioId,
              scheduledClassId,
              userId: targetUserId,
              status: BookingStatus.CONFIRMED,
            },
          });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new ConflictException('Already booked for this class');
          }
          throw e;
        }
      },
      { timeout: 15_000 },
    );
  }

  async staffCancelBooking(studioId: string, userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, studioId, userId },
      include: { user: { select: { deletedAt: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.user.deletedAt) throw new NotFoundException('Booking not found');
    if (booking.status === BookingStatus.CANCELLED) {
      return { cancelled: false, promotion: null };
    }

    return this.prisma.$transaction(
      async (tx) => {
        await acquireBookingClassAdvisoryLock(tx, booking.scheduledClassId);

        const b = await tx.booking.findFirst({ where: { id: bookingId, studioId, userId } });
        if (!b || b.status === BookingStatus.CANCELLED) {
          return { cancelled: false, promotion: null };
        }

        await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: BookingStatus.CANCELLED,
            cancelSource: CancelSource.STUDIO,
            cancelledAt: new Date(),
          },
        });

        const promotion = await this.waitlistService.promoteNextAfterSpotOpenedInTx(
          tx,
          studioId,
          booking.scheduledClassId,
        );
        return { cancelled: true, promotion };
      },
      { timeout: 15_000 },
    );
  }

  async staffForceCheckIn(studioId: string, bookingId: string, actorUserId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, studioId },
      include: {
        user: { select: { deletedAt: true } },
        scheduledClass: true,
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.user.deletedAt) throw new ForbiddenException();
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new ConflictException('Only confirmed bookings can be checked in');
    }
    if (booking.scheduledClass.status !== ClassStatus.SCHEDULED) {
      throw new ConflictException('Check-in is only available for scheduled classes');
    }

    try {
      const attendance = await this.prisma.attendance.create({
        data: {
          studioId,
          scheduledClassId: booking.scheduledClassId,
          userId: booking.userId,
          method: CheckInMethod.MANUAL,
          checkedInByUserId: actorUserId,
        },
        include: {
          user: {
            select: { id: true, email: true, firstName: true, lastName: true, phone: true },
          },
        },
      });
      return { success: true, attendance };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Already checked in');
      }
      throw e;
    }
  }

  // ── Subscription management ────────────────────────────────────────────────

  async updateMemberSubscription(
    studioId: string,
    userId: string,
    subscriptionId: string,
    dto: UpdateSubscriptionStatusDto,
  ) {
    const sub = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, studioId, userId },
    });
    if (!sub) throw new NotFoundException('Subscription not found');
    return this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: dto.status },
      include: {
        membershipPlan: { select: { id: true, name: true } },
      },
    });
  }

  // ── Role ───────────────────────────────────────────────────────────────────

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

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async assertMembership(studioId: string, userId: string) {
    const m = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId, deletedAt: null },
    });
    if (!m) throw new NotFoundException('Member not found');
    return m;
  }
}
