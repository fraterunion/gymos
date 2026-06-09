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
} from '@prisma/client';
import { acquireBookingClassAdvisoryLock } from '../booking-class-advisory-lock';
import { PrismaService } from '../prisma/prisma.service';
import {
  type BookingCancellationResult,
  WaitlistService,
} from '../waitlist/waitlist.service';
import { BookingAccessService } from './booking-access.service';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly waitlistService: WaitlistService,
    private readonly bookingAccess: BookingAccessService,
  ) {}

  async createBooking(studioId: string, scheduledClassId: string, actorUserId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        await acquireBookingClassAdvisoryLock(tx, scheduledClassId);

        const [membership, scheduledClass, studio] = await Promise.all([
          tx.studioMembership.findFirst({
            where: { studioId, userId: actorUserId, deletedAt: null },
            include: { user: { select: { deletedAt: true } } },
          }),
          tx.scheduledClass.findFirst({
            where: { id: scheduledClassId, studioId },
          }),
          tx.studio.findUnique({
            where: { id: studioId },
            select: { timezone: true },
          }),
        ]);

        if (!membership || membership.user.deletedAt) {
          throw new ForbiddenException();
        }
        if (!scheduledClass) {
          throw new NotFoundException('Class not found');
        }
        // studio is verified by StudioMemberGuard before the transaction starts,
        // but TypeScript requires the explicit null check after findUnique.
        if (!studio) {
          throw new NotFoundException('Studio not found');
        }
        if (scheduledClass.status !== ClassStatus.SCHEDULED) {
          throw new ConflictException('This class is not open for booking');
        }
        const now = new Date();
        if (scheduledClass.startsAt <= now) {
          throw new ConflictException('Cannot book a class that has already started');
        }

        await this.bookingAccess.assertAccess(
          tx,
          studioId,
          actorUserId,
          membership.role,
          scheduledClass.startsAt,
          studio.timezone,
          scheduledClass.classTemplateId,
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

  async cancelBooking(
    studioId: string,
    bookingId: string,
    actorUserId: string,
  ): Promise<BookingCancellationResult> {
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
      return { cancelled: false, promotion: null };
    }

    return this.prisma.$transaction(
      async (tx) => {
        await acquireBookingClassAdvisoryLock(tx, booking.scheduledClassId);

        const b = await tx.booking.findFirst({
          where: { id: bookingId, studioId },
          include: { user: { select: { deletedAt: true } } },
        });
        if (!b) {
          throw new NotFoundException('Booking not found');
        }
        if (b.user.deletedAt) {
          throw new NotFoundException('Booking not found');
        }
        const selfHere = b.userId === actorUserId;
        if (!selfHere && !canManageOthers) {
          throw new ForbiddenException();
        }
        if (b.status === BookingStatus.CANCELLED) {
          return { cancelled: false, promotion: null };
        }

        await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: BookingStatus.CANCELLED,
            cancelSource: selfHere ? CancelSource.MEMBER : CancelSource.STUDIO,
            cancelledAt: new Date(),
          },
        });

        const promotion = await this.waitlistService.promoteNextAfterSpotOpenedInTx(
          tx,
          studioId,
          b.scheduledClassId,
        );
        return { cancelled: true, promotion };
      },
      { timeout: 15_000 },
    );
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

}
