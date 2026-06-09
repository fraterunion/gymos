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
  DayPassStatus,
  Prisma,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import { acquireBookingClassAdvisoryLock } from '../booking-class-advisory-lock';
import {
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
} from '../common/date/studio-local-date';
import { PrismaService } from '../prisma/prisma.service';
import {
  type BookingCancellationResult,
  WaitlistService,
} from '../waitlist/waitlist.service';

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

        await this.assertBookingAccessForMember(
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

  private async assertBookingAccessForMember(
    tx: Prisma.TransactionClient,
    studioId: string,
    userId: string,
    membershipRole: Role,
    classStartsAt: Date,
    studioTimezone: string,
    classTemplateId: string,
  ): Promise<void> {
    if (bypassSubscriptionRoles.has(membershipRole)) {
      return;
    }

    // Gate 1: active or trialing subscription.
    // currentPeriodStart/End are fetched here for the credit check below.
    const sub = await tx.subscription.findFirst({
      where: {
        userId,
        studioId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
      },
      select: {
        currentPeriodStart: true,
        currentPeriodEnd: true,
        membershipPlan: {
          select: {
            allowedCategories: true,
            classCredits: true,
          },
        },
      },
    });

    // Denial flags — mutually exclusive, both checked before Gate 2 so a Day
    // Pass can override either. subscriptionRestricted fires when category
    // doesn't match (credit check is skipped in that case). creditsExhausted
    // fires when category passes but all credits for the billing period are
    // spent. Neither fires when sub is null (no subscription at all).
    let subscriptionRestricted = false;
    let creditsExhausted = false;

    if (sub) {
      const { allowedCategories, classCredits } = sub.membershipPlan;

      // ── Category check ─────────────────────────────────────────────────────
      if (allowedCategories.length > 0) {
        // Category-restricted plan: verify the class template's category is
        // allowed. A null category on the template fails the restriction.
        const template = await tx.classTemplate.findUnique({
          where: { id: classTemplateId },
          select: { category: true },
        });

        if (!template?.category || !allowedCategories.includes(template.category)) {
          // Plan doesn't cover this class type. Do NOT throw yet —
          // a Day Pass overrides for its valid date.
          subscriptionRestricted = true;
        }
      }

      // ── Credit check (only when category passed) ───────────────────────────
      if (!subscriptionRestricted && classCredits !== null) {
        // Both period bounds must be present to enforce credits accurately.
        // When either is missing (e.g. legacy subscription without a known
        // billing window) skip enforcement rather than produce a false denial.
        if (sub.currentPeriodStart && sub.currentPeriodEnd) {
          const used = await tx.booking.count({
            where: {
              studioId,
              userId,
              status: BookingStatus.CONFIRMED,
              scheduledClass: {
                startsAt: {
                  gte: sub.currentPeriodStart,
                  lt: sub.currentPeriodEnd,
                },
              },
            },
          });

          if (used >= classCredits) {
            // All credits spent. Do NOT throw yet — a Day Pass overrides.
            creditsExhausted = true;
          }
        }
      }

      // All Gate 1 checks passed — allow the booking.
      if (!subscriptionRestricted && !creditsExhausted) {
        return;
      }
    }

    // Gate 2: active Day Pass for the class's studio-local calendar date.
    // validForDate is the UTC anchor for local midnight on that date — computed
    // from studio.timezone so it works for any studio, not just Mexico City.
    // Day Pass is never category-restricted and bypasses credit limits.
    const dateKey = getStudioLocalDateKey(classStartsAt, studioTimezone);
    const validForDate = studioLocalDateKeyToUtcAnchor(dateKey, studioTimezone);

    const pass = await tx.dayPass.findFirst({
      where: {
        studioId,
        userId,
        status: DayPassStatus.ACTIVE,
        validForDate,
      },
    });
    if (pass) return;

    // Neither gate succeeded. Error priority:
    // category restriction > credits exhausted > no membership.
    if (subscriptionRestricted) {
      throw new ForbiddenException('Your membership does not include this class type.');
    }
    if (creditsExhausted) {
      throw new ForbiddenException('You have used all your class credits for this billing period.');
    }
    throw new ForbiddenException('Active membership or Day Pass required to book this class.');
  }
}
