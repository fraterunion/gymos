import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingStatus,
  CancelSource,
  ClassStatus,
  Prisma,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const rosterUserSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
} satisfies Prisma.UserSelect;

const bypassSubscriptionRoles: ReadonlySet<Role> = new Set([
  Role.STAFF,
  Role.INSTRUCTOR,
  Role.ADMIN,
  Role.OWNER,
]);

@Injectable()
export class BookingsService {
  constructor(private readonly prisma: PrismaService) {}

  async createBooking(studioId: string, scheduledClassId: string, actorUserId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.acquireBookingAdvisoryLock(tx, studioId, scheduledClassId);

        const [membership, scheduledClass] = await Promise.all([
          tx.studioMembership.findFirst({
            where: { studioId, userId: actorUserId, deletedAt: null },
            include: { user: { select: { deletedAt: true } } },
          }),
          tx.scheduledClass.findFirst({
            where: { id: scheduledClassId, studioId },
          }),
        ]);

        if (!membership || membership.user.deletedAt) {
          throw new ForbiddenException();
        }
        if (!scheduledClass) {
          throw new NotFoundException('Class not found');
        }
        if (scheduledClass.status !== ClassStatus.SCHEDULED) {
          throw new ConflictException('This class is not open for booking');
        }
        const now = new Date();
        if (scheduledClass.startsAt <= now) {
          throw new ConflictException('Cannot book a class that has already started');
        }

        await this.assertSubscriptionForMemberIfNeeded(
          tx,
          studioId,
          actorUserId,
          membership.role,
        );

        const confirmedCount = await tx.booking.count({
          where: {
            scheduledClassId,
            status: BookingStatus.CONFIRMED,
          },
        });
        if (confirmedCount >= scheduledClass.capacity) {
          throw new ConflictException('Class is full');
        }

        try {
          return await tx.booking.create({
            data: {
              studioId,
              scheduledClassId,
              userId: actorUserId,
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

  async cancelBooking(studioId: string, bookingId: string, actorUserId: string): Promise<void> {
    const actorMembership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId: actorUserId, deletedAt: null },
    });
    if (!actorMembership) {
      throw new ForbiddenException();
    }
    const canManageOthers = bypassSubscriptionRoles.has(actorMembership.role);

    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, studioId },
      include: {
        user: { select: { deletedAt: true } },
        scheduledClass: { select: { id: true, status: true } },
      },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.user.deletedAt) {
      throw new NotFoundException('Booking not found');
    }
    const isSelf = booking.userId === actorUserId;
    if (!isSelf && !canManageOthers) {
      throw new ForbiddenException();
    }
    if (booking.status === BookingStatus.CANCELLED) {
      return;
    }
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.CANCELLED,
        cancelSource: isSelf ? CancelSource.MEMBER : CancelSource.STUDIO,
        cancelledAt: new Date(),
      },
    });
  }

  async listMyUpcomingBookings(studioId: string, actorUserId: string) {
    const now = new Date();
    return this.prisma.booking.findMany({
      where: {
        studioId,
        userId: actorUserId,
        status: BookingStatus.CONFIRMED,
        user: { deletedAt: null },
        scheduledClass: {
          studioId,
          status: ClassStatus.SCHEDULED,
          startsAt: { gte: now },
        },
      },
      include: {
        scheduledClass: {
          select: {
            id: true,
            studioId: true,
            startsAt: true,
            endsAt: true,
            capacity: true,
            status: true,
            instructorId: true,
            classTemplateId: true,
          },
        },
      },
      orderBy: { scheduledClass: { startsAt: 'asc' } },
    });
  }

  async getRoster(studioId: string, scheduledClassId: string) {
    const scheduledClass = await this.prisma.scheduledClass.findFirst({
      where: { id: scheduledClassId, studioId },
    });
    if (!scheduledClass) {
      throw new NotFoundException('Class not found');
    }
    return this.prisma.booking.findMany({
      where: {
        studioId,
        scheduledClassId,
        status: BookingStatus.CONFIRMED,
        user: { deletedAt: null },
      },
      include: {
        user: { select: rosterUserSelect },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Only raw SQL permitted for locking. Must run inside a transaction.
   */
  private async acquireBookingAdvisoryLock(
    tx: Prisma.TransactionClient,
    studioId: string,
    scheduledClassId: string,
  ): Promise<void> {
    const lockKey = `gymos:booking:${studioId}:${scheduledClassId}`;
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock((hashtext(${lockKey}))::bigint)
    `);
  }

  private async assertSubscriptionForMemberIfNeeded(
    tx: Prisma.TransactionClient,
    studioId: string,
    userId: string,
    membershipRole: Role,
  ): Promise<void> {
    if (bypassSubscriptionRoles.has(membershipRole)) {
      return;
    }
    const sub = await tx.subscription.findFirst({
      where: {
        userId,
        studioId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
      },
    });
    if (!sub) {
      throw new ForbiddenException('Active subscription required to book');
    }
  }
}
