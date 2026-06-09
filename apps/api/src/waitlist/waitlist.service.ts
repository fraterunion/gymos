import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingStatus,
  ClassStatus,
  Prisma,
  Role,
  WaitlistStatus,
} from '@prisma/client';
import { acquireBookingClassAdvisoryLock } from '../booking-class-advisory-lock';
import { BookingAccessService } from '../bookings/booking-access.service';
import { PrismaService } from '../prisma/prisma.service';

const bypassSubscriptionRoles: ReadonlySet<Role> = new Set([
  Role.STAFF,
  Role.INSTRUCTOR,
  Role.ADMIN,
  Role.OWNER,
]);

const waitlistUserSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
} satisfies Prisma.UserSelect;

export type WaitlistPromotionDto = {
  performed: true;
  bookingId: string;
  waitlistEntryId: string;
  userId: string;
};

export type BookingCancellationResult = {
  cancelled: boolean;
  promotion: WaitlistPromotionDto | null;
};

export type ClassWaitlistEntryDto = {
  id: string;
  studioId: string;
  scheduledClassId: string;
  userId: string;
  status: WaitlistStatus;
  position: number;
  queueRank: number | null;
  createdAt: Date;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  };
};

@Injectable()
export class WaitlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingAccess: BookingAccessService,
  ) {}

  /**
   * Run inside an existing transaction after a CONFIRMED seat was freed.
   * If promotion booking insert hits P2002, throws and rolls back the entire outer transaction.
   */
  async promoteNextAfterSpotOpenedInTx(
    tx: Prisma.TransactionClient,
    studioId: string,
    scheduledClassId: string,
  ): Promise<WaitlistPromotionDto | null> {
    const confirmedCount = await tx.booking.count({
      where: { studioId, scheduledClassId, status: BookingStatus.CONFIRMED },
    });
    const scheduledClass = await tx.scheduledClass.findFirst({
      where: { id: scheduledClassId, studioId },
      select: { capacity: true },
    });
    if (!scheduledClass) {
      return null;
    }
    if (confirmedCount >= scheduledClass.capacity) {
      return null;
    }

    const next = await tx.waitlistEntry.findFirst({
      where: { studioId, scheduledClassId, status: WaitlistStatus.WAITING },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    if (!next) {
      return null;
    }

    try {
      const booking = await tx.booking.create({
        data: {
          studioId,
          scheduledClassId,
          userId: next.userId,
          status: BookingStatus.CONFIRMED,
        },
      });
      await tx.waitlistEntry.update({
        where: { id: next.id },
        data: { status: WaitlistStatus.PROMOTED },
      });
      return {
        performed: true,
        bookingId: booking.id,
        waitlistEntryId: next.id,
        userId: next.userId,
      };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Promotion failed due to a conflicting booking');
      }
      throw e;
    }
  }

  async joinWaitlist(studioId: string, scheduledClassId: string, actorUserId: string) {
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
        if (!studio) {
          throw new NotFoundException('Studio not found');
        }
        if (scheduledClass.status !== ClassStatus.SCHEDULED) {
          throw new ConflictException('This class is not open for the waitlist');
        }
        const now = new Date();
        if (scheduledClass.startsAt <= now) {
          throw new ConflictException('Cannot join the waitlist for a class that has already started');
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

        // Overlap check — members cannot join a waitlist for a class that
        // conflicts with an existing CONFIRMED booking. Back-to-back is allowed.
        // Mirrors the same guard in BookingsService.createBooking.
        // Staff/admin/instructor roles bypass this check.
        if (!bypassSubscriptionRoles.has(membership.role)) {
          const overlap = await tx.booking.findFirst({
            where: {
              studioId,
              userId: actorUserId,
              status: BookingStatus.CONFIRMED,
              scheduledClass: {
                startsAt: { lt: scheduledClass.endsAt },
                endsAt:   { gt: scheduledClass.startsAt },
              },
            },
            select: { id: true },
          });
          if (overlap) {
            throw new ConflictException(
              'You already have a class booked at this time. Cancel it before joining this waitlist.',
            );
          }
        }

        const confirmedCount = await tx.booking.count({
          where: {
            studioId,
            scheduledClassId,
            status: BookingStatus.CONFIRMED,
          },
        });
        if (confirmedCount < scheduledClass.capacity) {
          throw new ConflictException('Class has available spots — please book directly');
        }

        const existingBooking = await tx.booking.findFirst({
          where: {
            studioId,
            scheduledClassId,
            userId: actorUserId,
            status: BookingStatus.CONFIRMED,
          },
        });
        if (existingBooking) {
          throw new ConflictException('Already booked for this class');
        }

        const promotedOrWaiting = await tx.waitlistEntry.findFirst({
          where: {
            studioId,
            scheduledClassId,
            userId: actorUserId,
            status: { in: [WaitlistStatus.WAITING, WaitlistStatus.PROMOTED] },
          },
        });
        if (promotedOrWaiting) {
          throw new ConflictException('Already on the waitlist for this class');
        }

        const agg = await tx.waitlistEntry.aggregate({
          where: { studioId, scheduledClassId },
          _max: { position: true },
        });
        const nextPosition = (agg._max.position ?? 0) + 1;

        try {
          const created = await tx.waitlistEntry.create({
            data: {
              studioId,
              scheduledClassId,
              userId: actorUserId,
              status: WaitlistStatus.WAITING,
              position: nextPosition,
            },
          });
          return {
            id: created.id,
            studioId: created.studioId,
            scheduledClassId: created.scheduledClassId,
            status: created.status,
            position: created.position,
            createdAt: created.createdAt,
          };
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new ConflictException('Already on the waitlist for this class');
          }
          throw e;
        }
      },
      { timeout: 15_000 },
    );
  }

  async cancelWaitlistEntry(studioId: string, entryId: string, actorUserId: string): Promise<void> {
    const entry = await this.prisma.waitlistEntry.findFirst({
      where: { id: entryId, studioId },
      include: { user: { select: { deletedAt: true } } },
    });
    if (!entry) {
      throw new NotFoundException('Waitlist entry not found');
    }
    if (entry.user.deletedAt) {
      throw new NotFoundException('Waitlist entry not found');
    }

    const actorMembership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId: actorUserId, deletedAt: null },
    });
    if (!actorMembership) {
      throw new ForbiddenException();
    }
    const canManageOthers = bypassSubscriptionRoles.has(actorMembership.role);
    const isSelf = entry.userId === actorUserId;
    if (!isSelf && !canManageOthers) {
      throw new ForbiddenException();
    }

    await this.prisma.$transaction(async (tx) => {
      await acquireBookingClassAdvisoryLock(tx, entry.scheduledClassId);

      const row = await tx.waitlistEntry.findFirst({
        where: { id: entryId, studioId },
      });
      if (!row) {
        throw new NotFoundException('Waitlist entry not found');
      }
      if (row.status === WaitlistStatus.CANCELLED) {
        return;
      }
      if (row.status === WaitlistStatus.PROMOTED) {
        throw new ConflictException('Waitlist entry was already promoted');
      }
      if (row.status !== WaitlistStatus.WAITING) {
        throw new ConflictException('Waitlist entry cannot be cancelled');
      }

      await tx.waitlistEntry.update({
        where: { id: entryId },
        data: { status: WaitlistStatus.CANCELLED },
      });
    });
  }

  async listClassWaitlist(studioId: string, scheduledClassId: string): Promise<ClassWaitlistEntryDto[]> {
    const cls = await this.prisma.scheduledClass.findFirst({
      where: { id: scheduledClassId, studioId },
    });
    if (!cls) {
      throw new NotFoundException('Class not found');
    }

    const waitingRows = await this.prisma.waitlistEntry.findMany({
      where: {
        studioId,
        scheduledClassId,
        status: WaitlistStatus.WAITING,
        user: { deletedAt: null },
      },
      include: { user: { select: waitlistUserSelect } },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });

    const promotedRows = await this.prisma.waitlistEntry.findMany({
      where: {
        studioId,
        scheduledClassId,
        status: WaitlistStatus.PROMOTED,
        user: { deletedAt: null },
      },
      include: { user: { select: waitlistUserSelect } },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });

    const out: ClassWaitlistEntryDto[] = [];
    waitingRows.forEach((row, idx) => {
      out.push(this.toClassWaitlistDto(row, idx + 1));
    });
    promotedRows.forEach((row) => {
      out.push(this.toClassWaitlistDto(row, null));
    });
    return out;
  }

  async listMyWaitlist(studioId: string, actorUserId: string) {
    const rows = await this.prisma.waitlistEntry.findMany({
      where: {
        studioId,
        userId: actorUserId,
        status: { in: [WaitlistStatus.WAITING, WaitlistStatus.PROMOTED] },
        user: { deletedAt: null },
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
      orderBy: [{ scheduledClass: { startsAt: 'asc' } }, { position: 'asc' }, { createdAt: 'asc' }],
    });

    const classIds = [...new Set(rows.map((r) => r.scheduledClassId))];
    const rankByEntryId = new Map<string, number>();
    const waitingCountByClass = new Map<string, number>();

    for (const cid of classIds) {
      const orderedWaiting = await this.prisma.waitlistEntry.findMany({
        where: {
          studioId,
          scheduledClassId: cid,
          status: WaitlistStatus.WAITING,
          user: { deletedAt: null },
        },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      waitingCountByClass.set(cid, orderedWaiting.length);
      orderedWaiting.forEach((e, idx) => {
        rankByEntryId.set(e.id, idx + 1);
      });
    }

    return rows.map((row) => ({
      id: row.id,
      studioId: row.studioId,
      scheduledClassId: row.scheduledClassId,
      status: row.status,
      position: row.position,
      queueRank:
        row.status === WaitlistStatus.WAITING ? (rankByEntryId.get(row.id) ?? null) : null,
      waitingCountForClass: waitingCountByClass.get(row.scheduledClassId) ?? 0,
      createdAt: row.createdAt,
      scheduledClass: row.scheduledClass,
    }));
  }

  private toClassWaitlistDto(
    row: Prisma.WaitlistEntryGetPayload<{ include: { user: { select: typeof waitlistUserSelect } } }>,
    queueRank: number | null,
  ): ClassWaitlistEntryDto {
    return {
      id: row.id,
      studioId: row.studioId,
      scheduledClassId: row.scheduledClassId,
      userId: row.userId,
      status: row.status,
      position: row.position,
      queueRank,
      createdAt: row.createdAt,
      user: row.user,
    };
  }

}
