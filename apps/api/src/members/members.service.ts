import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { StripeService } from '../stripe/stripe.service';
import {
  BookingStatus,
  CancelSource,
  CheckInMethod,
  ClassStatus,
  PaymentStatus,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { acquireBookingClassAdvisoryLock } from '../booking-class-advisory-lock';
import { assertEligibleForCheckIn } from '../check-ins/check-in-eligibility';
import { PrismaService } from '../prisma/prisma.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import type { ListMembersQueryDto } from './dto/list-members-query.dto';
import type { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import type { UpdateSubscriptionStatusDto } from './dto/update-subscription-status.dto';
import type { UpsertMemberCrmProfileDto } from './dto/upsert-member-crm-profile.dto';

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
    private readonly stripeService: StripeService,
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
      const parts = s.split(/\s+/).filter(Boolean);
      userFilter.OR = [
        { firstName: { contains: s, mode: 'insensitive' } },
        { lastName: { contains: s, mode: 'insensitive' } },
        { email: { contains: s, mode: 'insensitive' } },
      ];
      if (parts.length >= 2) {
        userFilter.OR.push({
          AND: [
            { firstName: { contains: parts[0], mode: 'insensitive' } },
            { lastName: { contains: parts.slice(1).join(' '), mode: 'insensitive' } },
          ],
        });
      }
    }

    const where: Prisma.StudioMembershipWhereInput = {
      studioId,
      deletedAt: null,
      user: userFilter,
      ...(query.role ? { role: query.role } : {}),
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

    const [bookingCounts, noShowCounts, lastAttendances, subscriptions] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ['userId'],
        where: {
          studioId,
          userId: { in: userIds },
          status: { not: BookingStatus.CANCELLED },
        },
        _count: { _all: true },
      }),
      this.prisma.booking.groupBy({
        by: ['userId'],
        where: {
          studioId,
          userId: { in: userIds },
          status: BookingStatus.NO_SHOW,
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
    const noShowCountMap = new Map(noShowCounts.map((r) => [r.userId, r._count._all]));
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
        noShowCount: noShowCountMap.get(m.userId) ?? 0,
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

    if (query.hasNoShows) {
      enriched = enriched.filter((m) => m.noShowCount > 0);
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

    const [attendanceTotal, activeSubscription, bookingGroups] = await Promise.all([
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
              allowedCategories: true,
            },
          },
        },
      }),
      this.prisma.booking.groupBy({
        by: ['status'],
        where: { studioId, userId },
        _count: { _all: true },
      }),
    ]);

    const totalBookings = bookingGroups.reduce((s, g) => s + g._count._all, 0);
    const noShowCount = bookingGroups.find((g) => g.status === BookingStatus.NO_SHOW)?._count._all ?? 0;
    const cancelledCount = bookingGroups.find((g) => g.status === BookingStatus.CANCELLED)?._count._all ?? 0;

    // Compute credit usage for credit-limited plans. Runs after the parallel
    // queries because it depends on subscription data. Skipped entirely for
    // unlimited plans (classCredits = null) — zero extra DB round-trip.
    let creditsUsed: number | null = null;
    let creditsRemaining: number | null = null;

    if (activeSubscription) {
      const { classCredits } = activeSubscription.membershipPlan;

      if (classCredits !== null) {
        const { currentPeriodStart, currentPeriodEnd } = activeSubscription;

        if (currentPeriodStart && currentPeriodEnd) {
          // Must mirror BookingAccessService.assertAccess exactly:
          // CONFIRMED bookings whose scheduled class starts within the period.
          creditsUsed = await this.prisma.booking.count({
            where: {
              studioId,
              userId,
              status: BookingStatus.CONFIRMED,
              scheduledClass: {
                startsAt: {
                  gte: currentPeriodStart,
                  lt: currentPeriodEnd,
                },
              },
            },
          });
          creditsRemaining = Math.max(classCredits - creditsUsed, 0);
        }
        // else: cannot compute without billing period bounds — leave null.
      }
      // else: unlimited plan (classCredits = null) — leave null.
    }

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
      bookingStats: {
        totalBookings,
        attendedCount: attendanceTotal,
        noShowCount,
        cancelledCount,
      },
      activeSubscription: activeSubscription
        ? {
            id: activeSubscription.id,
            status: activeSubscription.status,
            currentPeriodStart: activeSubscription.currentPeriodStart,
            currentPeriodEnd: activeSubscription.currentPeriodEnd,
            cancelAtPeriodEnd: activeSubscription.cancelAtPeriodEnd,
            plan: activeSubscription.membershipPlan,
            creditsUsed,
            creditsRemaining,
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
            allowedCategories: true,
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

    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { checkInWindowMinutes: true },
    });
    if (!studio) throw new NotFoundException('Studio not found');

    const now = new Date();
    assertEligibleForCheckIn(
      booking,
      booking.scheduledClass,
      now,
      studio.checkInWindowMinutes,
    );

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

  async createManualSubscription(
    studioId: string,
    userId: string,
    planId: string,
    stripeSubscriptionId?: string,
  ) {
    await this.assertMembership(studioId, userId);

    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: planId, studioId, deletedAt: null, active: true },
    });
    if (!plan) throw new NotFoundException('Membership plan not found');

    const now = new Date();
    const periodEnd = new Date(now);
    if (plan.billingInterval === 'MONTHLY') {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    } else if (plan.billingInterval === 'YEARLY') {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else if (plan.billingInterval === 'WEEKLY') {
      periodEnd.setDate(periodEnd.getDate() + 7);
    }

    return this.prisma.subscription.create({
      data: {
        studioId,
        userId,
        membershipPlanId: planId,
        status: SubscriptionStatus.ACTIVE,
        stripeSubscriptionId: stripeSubscriptionId ?? null,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
      include: {
        membershipPlan: { select: { id: true, name: true, billingInterval: true, priceCents: true, currency: true, allowedCategories: true } },
      },
    });
  }

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

  async setCancelAtPeriodEnd(
    studioId: string,
    userId: string,
    subscriptionId: string,
    cancel: boolean,
  ) {
    const sub = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, studioId, userId },
    });
    if (!sub) throw new NotFoundException('Subscription not found');

    const updated = await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { cancelAtPeriodEnd: cancel },
      include: {
        membershipPlan: { select: { id: true, name: true } },
      },
    });

    // Sync to Stripe if subscription is Stripe-managed
    if (sub.stripeSubscriptionId) {
      try {
        await this.stripeService.updateSubscription(sub.stripeSubscriptionId, {
          cancel_at_period_end: cancel,
        });
      } catch (err) {
        // Log but don't fail — webhook will reconcile the state
        const msg = err instanceof Error ? err.message : String(err);
        throw new BadRequestException(`DB updated but Stripe sync failed: ${msg}`);
      }
    }

    return updated;
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

  // ── Timeline ──────────────────────────────────────────────────────────────

  async getMemberTimeline(studioId: string, userId: string) {
    await this.assertMembership(studioId, userId);

    const [membership, bookings, attendances, subscriptions, payments, crmProfile] =
      await Promise.all([
        this.prisma.studioMembership.findFirst({
          where: { studioId, userId, deletedAt: null },
        }),
        this.prisma.booking.findMany({
          where: { studioId, userId },
          include: {
            scheduledClass: {
              include: {
                classTemplate: { select: { id: true, name: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
        this.prisma.attendance.findMany({
          where: { studioId, userId },
          include: {
            scheduledClass: {
              include: {
                classTemplate: { select: { id: true, name: true } },
              },
            },
          },
          orderBy: { checkedInAt: 'desc' },
          take: 200,
        }),
        this.prisma.subscription.findMany({
          where: { studioId, userId },
          include: { membershipPlan: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.payment.findMany({
          where: { studioId, userId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        this.prisma.studioMemberProfile.findUnique({
          where: { studioId_userId: { studioId, userId } },
        }),
      ]);

    type TimelineEvent = {
      type: string;
      title: string;
      description?: string | null;
      occurredAt: Date;
    };

    const events: TimelineEvent[] = [];

    if (membership) {
      events.push({ type: 'MEMBER_CREATED', title: 'Joined the studio', occurredAt: membership.createdAt });
    }

    for (const b of bookings) {
      const className = b.scheduledClass.classTemplate.name;
      if (b.status === BookingStatus.NO_SHOW) {
        events.push({ type: 'BOOKING_NO_SHOW', title: 'No-show', description: className, occurredAt: b.updatedAt });
      } else if (b.status === BookingStatus.CANCELLED) {
        events.push({ type: 'BOOKING_CANCELLED', title: 'Booking cancelled', description: className, occurredAt: b.cancelledAt ?? b.updatedAt });
      } else {
        events.push({ type: 'BOOKING_CREATED', title: 'Booked a class', description: className, occurredAt: b.createdAt });
      }
    }

    for (const a of attendances) {
      events.push({ type: 'CHECKED_IN', title: 'Checked in', description: a.scheduledClass.classTemplate.name, occurredAt: a.checkedInAt });
    }

    for (const s of subscriptions) {
      events.push({ type: 'MEMBERSHIP_ASSIGNED', title: 'Membership assigned', description: s.membershipPlan.name, occurredAt: s.createdAt });
    }

    for (const p of payments) {
      if (p.status === PaymentStatus.SUCCEEDED) {
        const amount = `${p.currency.toUpperCase()} ${(p.amountCents / 100).toFixed(2)}`;
        events.push({ type: 'PAYMENT_SUCCEEDED', title: 'Payment succeeded', description: amount, occurredAt: p.paidAt ?? p.createdAt });
      } else if (p.status === PaymentStatus.FAILED) {
        events.push({ type: 'PAYMENT_FAILED', title: 'Payment failed', occurredAt: p.createdAt });
      }
    }

    if (crmProfile && crmProfile.updatedAt.getTime() - crmProfile.createdAt.getTime() > 60_000) {
      events.push({ type: 'CRM_UPDATED', title: 'Coach notes updated', occurredAt: crmProfile.updatedAt });
    }

    events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    return events.slice(0, 200);
  }

  // ── Attendance log (bookings + check-in status) ────────────────────────────

  async getMemberAttendanceLog(studioId: string, userId: string, page: number, limit: number) {
    await this.assertMembership(studioId, userId);
    const skip = (page - 1) * limit;

    const where: Prisma.BookingWhereInput = { studioId, userId };

    const [bookings, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
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
      this.prisma.booking.count({ where }),
    ]);

    if (bookings.length === 0) return { data: [], total, page, limit };

    const scheduledClassIds = bookings.map((b) => b.scheduledClassId);
    const attendances = await this.prisma.attendance.findMany({
      where: { studioId, userId, scheduledClassId: { in: scheduledClassIds } },
      select: { scheduledClassId: true, checkedInAt: true, method: true },
    });
    const attendedMap = new Map(attendances.map((a) => [a.scheduledClassId, a]));

    const now = new Date();
    const data = bookings.map((b) => {
      const att = attendedMap.get(b.scheduledClassId);
      const isPast = new Date(b.scheduledClass.startsAt) <= now;
      const attendanceStatus =
        b.status === BookingStatus.NO_SHOW ? 'NO_SHOW'
        : b.status === BookingStatus.CANCELLED ? 'CANCELLED'
        : att ? 'ATTENDED'
        : isPast ? 'MISSED'
        : 'UPCOMING';
      return {
        id: b.id,
        status: b.status,
        attendanceStatus,
        createdAt: b.createdAt,
        cancelledAt: b.cancelledAt,
        canMarkNoShow: isPast && b.status === BookingStatus.CONFIRMED && !att,
        checkedInAt: att?.checkedInAt ?? null,
        checkInMethod: att?.method ?? null,
        scheduledClass: b.scheduledClass,
      };
    });

    return { data, total, page, limit };
  }

  // ── No-show marking ────────────────────────────────────────────────────────

  async staffMarkNoShow(studioId: string, userId: string, bookingId: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, studioId, userId },
      include: {
        scheduledClass: { select: { startsAt: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.status === BookingStatus.NO_SHOW) {
      throw new ConflictException('Booking is already marked as no-show');
    }
    if (booking.status === BookingStatus.CANCELLED) {
      throw new ConflictException('Cannot mark a cancelled booking as no-show');
    }
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new ConflictException('Only confirmed bookings can be marked as no-show');
    }
    if (new Date(booking.scheduledClass.startsAt) > new Date()) {
      throw new ConflictException('Class has not started yet');
    }
    const hasAttendance = await this.prisma.attendance.findFirst({
      where: { studioId, userId, scheduledClassId: booking.scheduledClassId },
    });
    if (hasAttendance) {
      throw new ConflictException('Member has already checked in for this class');
    }
    return this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.NO_SHOW },
    });
  }

  // ── CRM profile ───────────────────────────────────────────────────────────

  async getMemberCrmProfile(studioId: string, userId: string) {
    await this.assertMembership(studioId, userId);
    return this.prisma.studioMemberProfile.findUnique({
      where: { studioId_userId: { studioId, userId } },
    });
  }

  async upsertMemberCrmProfile(
    studioId: string,
    userId: string,
    dto: UpsertMemberCrmProfileDto,
  ) {
    await this.assertMembership(studioId, userId);
    const data = {
      ...(dto.birthdate !== undefined ? { birthdate: dto.birthdate ? new Date(dto.birthdate) : null } : {}),
      ...(dto.emergencyContactName !== undefined ? { emergencyContactName: dto.emergencyContactName } : {}),
      ...(dto.emergencyContactPhone !== undefined ? { emergencyContactPhone: dto.emergencyContactPhone } : {}),
      ...(dto.emergencyContactRelation !== undefined ? { emergencyContactRelation: dto.emergencyContactRelation } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.goals !== undefined ? { goals: dto.goals } : {}),
      ...(dto.injuries !== undefined ? { injuries: dto.injuries } : {}),
    };
    return this.prisma.studioMemberProfile.upsert({
      where: { studioId_userId: { studioId, userId } },
      create: { studioId, userId, ...data },
      update: data,
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
