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
  Role,
  SubscriptionSource,
  SubscriptionStatus,
} from '@prisma/client';
import { SubscriptionLifecycleService } from '../billing/subscription-lifecycle.service';
import { RENEWABLE_SUBSCRIPTION_STATUSES } from '../billing/subscription-lifecycle.constants';
import { acquireBookingClassAdvisoryLock } from '../booking-class-advisory-lock';
import { assertEligibleForCheckIn } from '../check-ins/check-in-eligibility';
import { PrismaService } from '../prisma/prisma.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import { MembershipUsageService } from '../membership-usage/membership-usage.service';
import {
  currentlyEntitledSubscriptionWhere,
  deriveMembershipLifecycle,
  MEMBERSHIP_EXPIRED_MESSAGE,
} from '../memberships/membership-entitlement';
import {
  isClassIncludedInPlan,
  MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE,
} from '../membership-plans/membership-plan-class-access.utils';
import { getStudioLocalHHmm } from '../common/date/studio-local-date';
import { CLASS_TIME_WINDOW_DENIED_MESSAGE } from '../bookings/booking-access.service';
import type { ListMembersQueryDto } from './dto/list-members-query.dto';
import type { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import type { UpdateSubscriptionStatusDto } from './dto/update-subscription-status.dto';
import type { UpsertMemberCrmProfileDto } from './dto/upsert-member-crm-profile.dto';
import { matchesActivityFilter, matchesLifecycleFilter, matchesPaymentSource, selectHighestMemberAttention, toPrimaryMembershipStatus } from './member-operations';

const ENTITLEMENT_OVERRIDE_ROLES: ReadonlySet<Role> = new Set([Role.ADMIN, Role.OWNER]);

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
    private readonly membershipUsage: MembershipUsageService,
    private readonly subscriptionLifecycle: SubscriptionLifecycleService,
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
        { phone: { contains: s, mode: 'insensitive' } },
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
      return { data: [], total: 0, page, limit, summary: { total: 0, active: 0, ending: 0, expired: 0, pastDue: 0, noMembership: 0, inactive30d: 0, noShows: 0 } };
    }

    const userIds = memberships.map((m) => m.userId);

    const directoryNow = new Date();
    const thirtyDaysAgo = new Date(directoryNow.getTime() - 30 * 86_400_000);
    const [bookingCounts, noShowCounts, lastAttendances, subscriptions, futureBookings, latestPayments, activeWaiver, waiverAcceptances] = await Promise.all([
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
          scheduledClass: { startsAt: { gte: thirtyDaysAgo } },
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
          membershipPlan: { select: { id: true, name: true, classCredits: true, entitlementDays: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.booking.findMany({
        where: { studioId, userId: { in: userIds }, status: BookingStatus.CONFIRMED, scheduledClass: { startsAt: { gt: directoryNow } } },
        select: { userId: true, id: true, scheduledClass: { select: { id: true, startsAt: true, classTemplate: { select: { name: true } } } } },
        orderBy: { scheduledClass: { startsAt: 'asc' } },
      }),
      this.prisma.payment.findMany({
        where: { studioId, userId: { in: userIds } },
        select: { userId: true, status: true, paymentMethod: true, amountCents: true, currency: true, paidAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.studioWaiverDocument.findFirst({
        where: { studioId, isActive: true },
        select: { id: true },
      }),
      this.prisma.waiverAcceptance.findMany({
        where: { studioId, userId: { in: userIds }, waiverDocument: { isActive: true } },
        select: { userId: true },
      }),
    ]);

    const bookingCountMap = new Map(bookingCounts.map((r) => [r.userId, r._count._all]));
    const noShowCountMap = new Map(noShowCounts.map((r) => [r.userId, r._count._all]));
    const lastAttendanceMap = new Map(lastAttendances.map((r) => [r.userId, r._max.checkedInAt]));

    const subMap = new Map<string, (typeof subscriptions)[0]>();
    for (const sub of subscriptions) {
      if (!subMap.has(sub.userId)) subMap.set(sub.userId, sub);
    }

    const creditSubscriptions = [...subMap.values()].filter((sub) => sub.membershipPlan.classCredits !== null && sub.currentPeriodStart && (sub.entitlementEndsAt ?? sub.currentPeriodEnd));
    const usageBookings = creditSubscriptions.length > 0
      ? await this.prisma.booking.findMany({
          where: {
            studioId,
            userId: { in: creditSubscriptions.map((sub) => sub.userId) },
            status: { in: [BookingStatus.CONFIRMED, BookingStatus.COMPLETED, BookingStatus.NO_SHOW] },
            scheduledClass: {
              startsAt: {
                gte: new Date(Math.min(...creditSubscriptions.map((sub) => sub.currentPeriodStart!.getTime()))),
                lt: new Date(Math.max(...creditSubscriptions.map((sub) => (sub.entitlementEndsAt ?? sub.currentPeriodEnd)!.getTime()))),
              },
            },
          },
          select: { userId: true, scheduledClass: { select: { startsAt: true } } },
        })
      : [];

    const nextBookingMap = new Map<string, (typeof futureBookings)[0]>();
    for (const booking of futureBookings) if (!nextBookingMap.has(booking.userId)) nextBookingMap.set(booking.userId, booking);
    const paymentMap = new Map<string, (typeof latestPayments)[0]>();
    for (const payment of latestPayments) if (!paymentMap.has(payment.userId)) paymentMap.set(payment.userId, payment);
    const waiverAcceptedUserIds = new Set(waiverAcceptances.map((acceptance) => acceptance.userId));
    const usageMap = new Map<string, number>();
    for (const booking of usageBookings) {
      const sub = subMap.get(booking.userId);
      if (!sub || sub.membershipPlan.classCredits === null) continue;
      const end = sub.entitlementEndsAt ?? sub.currentPeriodEnd;
      if ((!sub.currentPeriodStart || booking.scheduledClass.startsAt >= sub.currentPeriodStart) && end && booking.scheduledClass.startsAt < end) {
        usageMap.set(booking.userId, (usageMap.get(booking.userId) ?? 0) + 1);
      }
    }

    const lifecycleNow = directoryNow;
    let enriched = memberships.map((m) => {
      const sub = subMap.get(m.userId);
      const lifecycle = sub ? deriveMembershipLifecycle(sub, lifecycleNow) : null;
      const used = sub?.membershipPlan.classCredits === null ? null : usageMap.get(m.userId) ?? 0;
      const remaining = !sub || sub.membershipPlan.classCredits === null ? null : Math.max(sub.membershipPlan.classCredits - (used ?? 0), 0);
      const nextBooking = nextBookingMap.get(m.userId);
      const lastPayment = paymentMap.get(m.userId);
      const primaryStatus = lifecycle ? toPrimaryMembershipStatus(lifecycle.lifecycleStatus) : null;
      const attention = selectHighestMemberAttention({ lifecycleStatus: lifecycle?.lifecycleStatus ?? null, effectiveEnd: lifecycle?.effectiveEnd ?? null, creditsRemaining: remaining, waiverPending: Boolean(activeWaiver) && !waiverAcceptedUserIds.has(m.userId), noShowCount: noShowCountMap.get(m.userId) ?? 0, lastAttendanceAt: lastAttendanceMap.get(m.userId) ?? null }, directoryNow);
      return {
        membershipId: m.id,
        role: m.role,
        joinedAt: m.createdAt,
        user: m.user,
        totalBookings: bookingCountMap.get(m.userId) ?? 0,
        noShowCount: noShowCountMap.get(m.userId) ?? 0,
        lastAttendanceAt: lastAttendanceMap.get(m.userId) ?? null,
        nextBooking: nextBooking ? { id: nextBooking.id, classId: nextBooking.scheduledClass.id, startsAt: nextBooking.scheduledClass.startsAt, className: nextBooking.scheduledClass.classTemplate.name } : null,
        usage: sub ? { limit: sub.membershipPlan.classCredits, used, remaining } : null,
        lastPayment,
        attention,
        subscription: sub
          ? {
              id: sub.id,
              status: sub.status,
              accessState: lifecycle!.accessState,
              lifecycleStatus: lifecycle!.lifecycleStatus,
              primaryStatus,
              isEntitled: lifecycle!.isEntitled,
              planName: sub.membershipPlan.name,
              planId: sub.membershipPlan.id,
              classCredits: sub.membershipPlan.classCredits,
              entitlementDays: sub.membershipPlan.entitlementDays,
              source: sub.source,
              currentPeriodStart: sub.currentPeriodStart,
              currentPeriodEnd: sub.currentPeriodEnd,
              effectiveEnd: lifecycle!.effectiveEnd,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            }
          : null,
      };
    });

    const summary = {
      total: enriched.length,
      active: enriched.filter((m) => m.subscription?.primaryStatus === 'ACTIVE').length,
      ending: enriched.filter((m) => matchesActivityFilter({ lastAttendanceAt: m.lastAttendanceAt, noShowCount: m.noShowCount, hasFutureBooking: !!m.nextBooking, lifecycleStatus: m.subscription?.lifecycleStatus ?? null, effectiveEnd: m.subscription?.effectiveEnd ?? null }, 'ENDING_7D', directoryNow)).length,
      expired: enriched.filter((m) => m.subscription?.lifecycleStatus === 'EXPIRED').length,
      pastDue: enriched.filter((m) => m.subscription?.lifecycleStatus === 'PAST_DUE').length,
      noMembership: enriched.filter((m) => !m.subscription).length,
      inactive30d: enriched.filter((m) => !m.lastAttendanceAt || m.lastAttendanceAt < thirtyDaysAgo).length,
      noShows: enriched.filter((m) => m.noShowCount > 0).length,
    };

    if (query.lifecycleStatus) enriched = enriched.filter((m) => matchesLifecycleFilter(m.subscription?.lifecycleStatus ?? null, query.lifecycleStatus));
    if (query.planId) enriched = enriched.filter((m) => m.subscription?.planId === query.planId);
    if (query.paymentSource) enriched = enriched.filter((m) => matchesPaymentSource(m.subscription?.source ?? null, query.paymentSource));

    if (query.hasNoShows) {
      enriched = enriched.filter((m) => m.noShowCount > 0);
    }

    if (query.activity) {
      enriched = enriched.filter((m) => matchesActivityFilter({ lastAttendanceAt: m.lastAttendanceAt, noShowCount: m.noShowCount, hasFutureBooking: !!m.nextBooking, lifecycleStatus: m.subscription?.lifecycleStatus ?? null, effectiveEnd: m.subscription?.effectiveEnd ?? null }, query.activity, directoryNow));
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

    return { data, total, page, limit, summary };
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

    const profileNow = new Date();
    const thirtyDaysAgo = new Date(profileNow.getTime() - 30 * 86_400_000);
    const [attendanceTotal, latestSubscription, bookingGroups, lastAttendance, nextBooking, lastPayment, recentNoShows] = await Promise.all([
      this.prisma.attendance.count({
        where: { studioId, userId },
      }),
      this.prisma.subscription.findFirst({
        where: { studioId, userId },
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
              entitlementDays: true,
              allowedCategories: true,
              allClassesAccess: true,
              classTemplateAccess: {
                select: { classTemplateId: true },
              },
            },
          },
          pendingMembershipPlan: {
            select: {
              id: true,
              name: true,
              billingInterval: true,
              priceCents: true,
              currency: true,
            },
          },
        },
      }),
      this.prisma.booking.groupBy({
        by: ['status'],
        where: { studioId, userId },
        _count: { _all: true },
      }),
      this.prisma.attendance.findFirst({
        where: { studioId, userId },
        orderBy: { checkedInAt: 'desc' },
        include: { scheduledClass: { select: { id: true, startsAt: true, classTemplate: { select: { name: true } } } } },
      }),
      this.prisma.booking.findFirst({
        where: { studioId, userId, status: BookingStatus.CONFIRMED, scheduledClass: { startsAt: { gt: profileNow } } },
        orderBy: { scheduledClass: { startsAt: 'asc' } },
        include: { scheduledClass: { select: { id: true, startsAt: true, classTemplate: { select: { name: true } } } } },
      }),
      this.prisma.payment.findFirst({
        where: { studioId, userId },
        orderBy: { createdAt: 'desc' },
        include: { membershipPlan: { select: { id: true, name: true } } },
      }),
      this.prisma.booking.count({ where: { studioId, userId, status: BookingStatus.NO_SHOW, scheduledClass: { startsAt: { gte: thirtyDaysAgo } } } }),
    ]);

    const totalBookings = bookingGroups.reduce((s, g) => s + g._count._all, 0);
    const noShowCount = bookingGroups.find((g) => g.status === BookingStatus.NO_SHOW)?._count._all ?? 0;
    const cancelledCount = bookingGroups.find((g) => g.status === BookingStatus.CANCELLED)?._count._all ?? 0;

    // Compute credit usage for credit-limited plans via shared membership usage.
    let creditsUsed: number | null = null;
    let creditsRemaining: number | null = null;

    const latestLifecycle = latestSubscription ? deriveMembershipLifecycle(latestSubscription, profileNow) : null;
    const activeSubscription = latestSubscription && latestLifecycle?.isEntitled ? latestSubscription : null;

    if (latestSubscription) {
      const { classCredits } = latestSubscription.membershipPlan;

      if (classCredits !== null) {
        const period = this.membershipUsage.resolveBillingPeriodForClassDate(
          latestSubscription,
          latestSubscription.currentPeriodStart ?? profileNow,
        );
        if (period) {
          const usage = await this.membershipUsage.getUsageForPeriod(
            this.prisma,
            studioId,
            userId,
            period,
            classCredits,
          );
          creditsUsed = usage.creditsUsed;
          creditsRemaining = usage.creditsRemaining;
        }
      }
    }

    const currentMembership = latestSubscription
      ? {
          id: latestSubscription.id,
          status: latestSubscription.status,
          source: latestSubscription.source,
          accessState: latestLifecycle!.accessState,
          lifecycleStatus: latestLifecycle!.lifecycleStatus,
          isEntitled: latestLifecycle!.isEntitled,
          effectiveEnd: latestLifecycle!.effectiveEnd,
          currentPeriodStart: latestSubscription.currentPeriodStart,
          currentPeriodEnd: latestSubscription.currentPeriodEnd,
          entitlementEndsAt: latestSubscription.entitlementEndsAt,
          cancelAtPeriodEnd: latestSubscription.cancelAtPeriodEnd,
          plan: {
            id: latestSubscription.membershipPlan.id,
            name: latestSubscription.membershipPlan.name,
            billingInterval: latestSubscription.membershipPlan.billingInterval,
            priceCents: latestSubscription.membershipPlan.priceCents,
            currency: latestSubscription.membershipPlan.currency,
            classCredits: latestSubscription.membershipPlan.classCredits,
            entitlementDays: latestSubscription.membershipPlan.entitlementDays,
            allowedCategories: latestSubscription.membershipPlan.allowedCategories,
            allClassesAccess: latestSubscription.membershipPlan.allClassesAccess,
            allowedTemplateIds: latestSubscription.membershipPlan.classTemplateAccess.map((row) => row.classTemplateId),
          },
          pendingPlan: latestSubscription.pendingMembershipPlan,
          creditsUsed,
          creditsRemaining,
        }
      : null;
    const daysSinceVisit = lastAttendance ? Math.floor((profileNow.getTime() - lastAttendance.checkedInAt.getTime()) / 86_400_000) : null;
    const attentionItems = [];
    if (latestLifecycle?.lifecycleStatus === 'PAST_DUE') attentionItems.push({ code: 'PAST_DUE', priority: 'critical', message: 'Pago pendiente', action: 'REVIEW_BILLING' });
    if (latestLifecycle?.lifecycleStatus === 'EXPIRED') attentionItems.push({ code: 'EXPIRED', priority: 'critical', message: `Membresía vencida hace ${Math.max(0, Math.floor((profileNow.getTime() - latestLifecycle.effectiveEnd!.getTime()) / 86_400_000))} días`, action: 'RENEW' });
    if (creditsRemaining === 0) attentionItems.push({ code: 'ZERO_CREDITS', priority: 'warning', message: 'Sin créditos restantes', action: 'RENEW' });
    if (latestLifecycle?.lifecycleStatus === 'ENDING' && latestLifecycle.effectiveEnd && latestLifecycle.effectiveEnd.getTime() - profileNow.getTime() <= 7 * 86_400_000) attentionItems.push({ code: 'ENDING', priority: 'warning', message: `Termina en ${Math.max(0, Math.ceil((latestLifecycle.effectiveEnd.getTime() - profileNow.getTime()) / 86_400_000))} días`, action: 'RENEW' });
    if (recentNoShows > 0) attentionItems.push({ code: 'NO_SHOWS', priority: 'warning', message: `${recentNoShows} no-show${recentNoShows === 1 ? '' : 's'} en los últimos 30 días`, action: null });
    if (daysSinceVisit === null || daysSinceVisit >= 14) attentionItems.push({ code: 'INACTIVE', priority: 'informational', message: daysSinceVisit === null ? 'Nunca ha asistido' : `Sin visita en ${daysSinceVisit} días`, action: null });
    const segments = [
      ...(latestLifecycle?.lifecycleStatus === 'ENDING' && latestLifecycle.effectiveEnd && latestLifecycle.effectiveEnd.getTime() - profileNow.getTime() <= 7 * 86_400_000 ? ['ENDING_THIS_WEEK'] : []),
      ...(latestLifecycle?.lifecycleStatus === 'EXPIRED' ? ['EXPIRED_NOT_RENEWED'] : []),
      ...(latestLifecycle?.lifecycleStatus === 'PAST_DUE' ? ['PAST_DUE'] : []),
      ...(daysSinceVisit === null ? ['NEVER_ATTENDED'] : []),
      ...(daysSinceVisit !== null && daysSinceVisit >= 14 ? ['NO_VISIT_14D'] : []),
      ...(daysSinceVisit !== null && daysSinceVisit >= 30 ? ['NO_VISIT_30D'] : []),
      ...(recentNoShows > 0 ? ['HAS_NO_SHOWS'] : []),
      ...(profileNow.getTime() - membership.createdAt.getTime() <= 30 * 86_400_000 ? ['NEW_MEMBER'] : []),
    ];

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
      currentMembership,
      operations: {
        lastVisit: lastAttendance,
        nextBooking,
        lastPayment,
        recentNoShows,
        attendanceRate: totalBookings > 0 ? Math.round((attendanceTotal / totalBookings) * 100) : null,
        attentionItems,
        segments,
      },
      activeSubscription: activeSubscription
        ? {
            id: activeSubscription.id,
            status: activeSubscription.status,
            accessState: 'ENTITLED',
            lifecycleStatus: deriveMembershipLifecycle(activeSubscription, profileNow).lifecycleStatus,
            isEntitled: true,
            currentPeriodStart: activeSubscription.currentPeriodStart,
            currentPeriodEnd: activeSubscription.currentPeriodEnd,
            entitlementEndsAt: activeSubscription.entitlementEndsAt,
            cancelAtPeriodEnd: activeSubscription.cancelAtPeriodEnd,
            plan: {
              id: activeSubscription.membershipPlan.id,
              name: activeSubscription.membershipPlan.name,
              billingInterval: activeSubscription.membershipPlan.billingInterval,
              priceCents: activeSubscription.membershipPlan.priceCents,
              currency: activeSubscription.membershipPlan.currency,
              classCredits: activeSubscription.membershipPlan.classCredits,
              allowedCategories: activeSubscription.membershipPlan.allowedCategories,
              allClassesAccess: activeSubscription.membershipPlan.allClassesAccess,
              allowedTemplateIds: activeSubscription.membershipPlan.classTemplateAccess.map(
                (row) => row.classTemplateId,
              ),
            },
            pendingPlan: activeSubscription.pendingMembershipPlan
              ? {
                  id: activeSubscription.pendingMembershipPlan.id,
                  name: activeSubscription.pendingMembershipPlan.name,
                  billingInterval: activeSubscription.pendingMembershipPlan.billingInterval,
                  priceCents: activeSubscription.pendingMembershipPlan.priceCents,
                  currency: activeSubscription.pendingMembershipPlan.currency,
                }
              : null,
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
        include: { membershipPlan: { select: { id: true, name: true } }, recordedBy: { select: { firstName: true, lastName: true } } },
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
    const rows = await this.prisma.subscription.findMany({
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
        pendingMembershipPlan: {
          select: {
            id: true,
            name: true,
            billingInterval: true,
            priceCents: true,
            currency: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    return rows.map((subscription) => ({
      ...subscription,
      ...deriveMembershipLifecycle(subscription, now),
    }));
  }

  // ── Staff booking operations ───────────────────────────────────────────────

  async staffCreateBooking(
    studioId: string,
    targetUserId: string,
    scheduledClassId: string,
    actorUserId: string,
    overrideEntitlement?: boolean,
    overrideReason?: string,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        await acquireBookingClassAdvisoryLock(tx, scheduledClassId);

        const [membership, scheduledClass, studio] = await Promise.all([
          tx.studioMembership.findFirst({
            where: { studioId, userId: targetUserId, deletedAt: null },
            include: { user: { select: { deletedAt: true } } },
          }),
          tx.scheduledClass.findFirst({
            where: { id: scheduledClassId, studioId },
            include: {
              classTemplate: {
                select: { id: true, name: true, category: true, accessWindowStart: true, accessWindowEnd: true },
              },
            },
          }),
          tx.studio.findUnique({
            where: { id: studioId },
            select: { timezone: true },
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

        // Time-window enforcement: Open Gym (and any template with accessWindowStart/End) is a
        // hard product constraint — not a frontend hint — so it applies to staff bookings too.
        if (
          scheduledClass.classTemplate.accessWindowStart &&
          scheduledClass.classTemplate.accessWindowEnd &&
          studio
        ) {
          const localHHmm = getStudioLocalHHmm(scheduledClass.startsAt, studio.timezone);
          if (
            localHHmm < scheduledClass.classTemplate.accessWindowStart ||
            localHHmm >= scheduledClass.classTemplate.accessWindowEnd
          ) {
            throw new ForbiddenException(CLASS_TIME_WINDOW_DENIED_MESSAGE);
          }
        }

        // Entitlement check: verify the member's active subscription covers this class.
        // If it does not, an explicit override (ADMIN/OWNER only + mandatory reason) is required.
        const now = new Date();
        const memberSub = await tx.subscription.findFirst({
          where: {
            studioId,
            userId: targetUserId,
            ...currentlyEntitledSubscriptionWhere(now),
          },
          select: {
            membershipPlan: {
              select: {
                id: true,
                name: true,
                allClassesAccess: true,
                allowedCategories: true,
                classTemplateAccess: { select: { classTemplateId: true } },
              },
            },
          },
        });

        if (!memberSub && !overrideEntitlement) {
          throw new ForbiddenException(MEMBERSHIP_EXPIRED_MESSAGE);
        }

        if (!memberSub && overrideEntitlement) {
          const actor = await tx.studioMembership.findFirst({
            where: { studioId, userId: actorUserId, deletedAt: null },
          });
          if (!actor || !ENTITLEMENT_OVERRIDE_ROLES.has(actor.role)) {
            throw new ForbiddenException('Entitlement override requires ADMIN or OWNER role.');
          }
          if (!overrideReason?.trim()) {
            throw new BadRequestException('overrideReason is required when overriding class entitlement.');
          }
          await tx.auditLog.create({
            data: {
              studioId,
              actorUserId,
              action: 'ENTITLEMENT_OVERRIDE_STAFF_BOOKING',
              targetUserId,
              entityType: 'ScheduledClass',
              entityId: scheduledClassId,
              metadata: {
                reason: overrideReason,
                classTemplateId: scheduledClass.classTemplateId,
                classTemplateName: scheduledClass.classTemplate.name,
                denialReason: MEMBERSHIP_EXPIRED_MESSAGE,
              },
            },
          });
        }

        if (memberSub) {
          const { allClassesAccess, allowedCategories, classTemplateAccess, id: planId, name: planName } =
            memberSub.membershipPlan;
          const allowedTemplateIds = classTemplateAccess.map((a) => a.classTemplateId);

          const hasAccess = isClassIncludedInPlan({
            allClassesAccess,
            allowedTemplateIds,
            allowedCategories,
            classTemplateId: scheduledClass.classTemplateId,
            templateCategory: scheduledClass.classTemplate.category,
          });

          if (!hasAccess) {
            if (!overrideEntitlement) {
              throw new ForbiddenException(MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE);
            }

            // Override: ADMIN or OWNER only, with a mandatory reason.
            const actor = await tx.studioMembership.findFirst({
              where: { studioId, userId: actorUserId, deletedAt: null },
            });
            if (!actor || !ENTITLEMENT_OVERRIDE_ROLES.has(actor.role)) {
              throw new ForbiddenException('Entitlement override requires ADMIN or OWNER role.');
            }
            if (!overrideReason?.trim()) {
              throw new BadRequestException('overrideReason is required when overriding class entitlement.');
            }

            await tx.auditLog.create({
              data: {
                studioId,
                actorUserId,
                action: 'ENTITLEMENT_OVERRIDE_STAFF_BOOKING',
                targetUserId,
                entityType: 'ScheduledClass',
                entityId: scheduledClassId,
                metadata: {
                  reason: overrideReason,
                  classTemplateId: scheduledClass.classTemplateId,
                  classTemplateName: scheduledClass.classTemplate.name,
                  membershipPlanId: planId,
                  membershipPlanName: planName,
                },
              },
            });
          }
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

    const existing = await this.subscriptionLifecycle.findCurrentRenewableSubscription(studioId, userId);
    if (existing) {
      throw new ConflictException(
        'Member already has a current membership. Change or cancel it before creating another.',
      );
    }

    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: planId, studioId, deletedAt: null, active: true },
    });
    if (!plan) throw new NotFoundException('Membership plan not found');

    const now = new Date();
    const periodEnd = new Date(now);
    if (plan.entitlementDays != null) {
      // Fixed-duration product: entitlementDays overrides billingInterval for period length.
      periodEnd.setTime(now.getTime() + plan.entitlementDays * 86_400_000);
    } else if (plan.billingInterval === 'MONTHLY') {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    } else if (plan.billingInterval === 'YEARLY') {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else if (plan.billingInterval === 'WEEKLY') {
      periodEnd.setDate(periodEnd.getDate() + 7);
    }

    // For fixed-duration plans, entitlementEndsAt is the access anchor (same as periodEnd here,
    // since manual subscriptions have no separate Stripe billing cycle to worry about).
    const entitlementEndsAt = plan.entitlementDays != null ? periodEnd : undefined;

    return this.prisma.subscription.create({
      data: {
        studioId,
        userId,
        membershipPlanId: planId,
        status: SubscriptionStatus.ACTIVE,
        source: stripeSubscriptionId ? SubscriptionSource.STRIPE : SubscriptionSource.MANUAL,
        stripeSubscriptionId: stripeSubscriptionId ?? null,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        ...(entitlementEndsAt !== undefined ? { entitlementEndsAt } : {}),
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

    const [membership, bookings, attendances, subscriptions, payments, crmProfile, operationalNotes] =
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
            checkedInBy: { select: { firstName: true, lastName: true } },
          },
          orderBy: { checkedInAt: 'desc' },
          take: 200,
        }),
        this.prisma.subscription.findMany({
          where: { studioId, userId },
          include: { membershipPlan: { select: { id: true, name: true } }, createdBy: { select: { firstName: true, lastName: true } } },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.payment.findMany({
          where: { studioId, userId },
          include: { recordedBy: { select: { firstName: true, lastName: true } }, membershipPlan: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        this.prisma.studioMemberProfile.findUnique({
          where: { studioId_userId: { studioId, userId } },
        }),
        this.prisma.memberOperationalNote.findMany({ where: { studioId, memberUserId: userId }, include: { author: { select: { firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      ]);

    type TimelineEvent = {
      type: string;
      title: string;
      description?: string | null;
      actor?: string | null;
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
      events.push({ type: 'CHECKED_IN', title: a.method === CheckInMethod.MANUAL ? 'Manual attendance' : 'Checked in', description: a.scheduledClass.classTemplate.name, actor: a.checkedInBy ? `${a.checkedInBy.firstName} ${a.checkedInBy.lastName}` : null, occurredAt: a.checkedInAt });
    }

    for (const s of subscriptions) {
      events.push({ type: 'MEMBERSHIP_ASSIGNED', title: 'Membership assigned', description: s.membershipPlan.name, actor: s.createdBy ? `${s.createdBy.firstName} ${s.createdBy.lastName}` : null, occurredAt: s.createdAt });
    }

    for (const p of payments) {
      if (p.status === PaymentStatus.SUCCEEDED) {
        const amount = `${p.currency.toUpperCase()} ${(p.amountCents / 100).toFixed(2)}`;
        events.push({ type: 'PAYMENT_SUCCEEDED', title: p.paymentMethod === 'CASH' ? 'Cash payment recorded' : 'Payment succeeded', description: `${amount}${p.membershipPlan ? ` · ${p.membershipPlan.name}` : ''}`, actor: p.recordedBy ? `${p.recordedBy.firstName} ${p.recordedBy.lastName}` : null, occurredAt: p.paidAt ?? p.createdAt });
      } else if (p.status === PaymentStatus.FAILED) {
        events.push({ type: 'PAYMENT_FAILED', title: 'Payment failed', occurredAt: p.createdAt });
      }
    }

    for (const note of operationalNotes) events.push({ type: 'NOTE_CREATED', title: 'Operational note added', description: note.body, actor: `${note.author.firstName} ${note.author.lastName}`, occurredAt: note.createdAt });

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
