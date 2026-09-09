import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CREDIT_CONSUMING_BOOKING_STATUSES,
  MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE,
} from './membership-usage.constants';
import {
  resolveBillingPeriodForClassDate,
  type BillingPeriodBounds,
} from './membership-usage-period.utils';
import {
  collapseConsumptionRows,
  eventBelongsToSubscription,
  type ConsumptionLegRow,
  type LegacyOwnershipCandidate,
} from './legacy-usage-attribution';

type DbClient = PrismaService | Prisma.TransactionClient;

/** PostgreSQL requires explicit enum casts when comparing `"BookingStatus"` via raw SQL. */
const CREDIT_CONSUMING_BOOKING_STATUS_SQL = Prisma.join(
  CREDIT_CONSUMING_BOOKING_STATUSES.map(
    (status) => Prisma.sql`${status}::"BookingStatus"`,
  ),
);

export type MembershipUsageSnapshot = {
  classCredits: number | null;
  creditsUsed: number;
  creditsRemaining: number | null;
  period: BillingPeriodBounds | null;
};

@Injectable()
export class MembershipUsageService {
  constructor(private readonly prisma: PrismaService) {}

  resolveBillingPeriodForClassDate(
    subscription: {
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
    },
    classStartsAt: Date,
  ): BillingPeriodBounds | null {
    return resolveBillingPeriodForClassDate(subscription, classStartsAt);
  }

  /**
   * Distinct scheduled classes consumed in [periodStart, periodEnd), attributed
   * by scheduled class start time (not booking/attendance creation time).
   */
  async countConsumedClasses(
    client: DbClient,
    studioId: string,
    userId: string,
    periodStart: Date,
    periodEnd: Date,
    subscriptionId?: string | null,
  ): Promise<number> {
    if (subscriptionId == null) {
      // Unscoped: total distinct consumed classes in the window — unchanged legacy query.
      const rows = await client.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM (
          SELECT b.scheduled_class_id
          FROM bookings b
          INNER JOIN scheduled_classes sc ON sc.id = b.scheduled_class_id
          WHERE b.studio_id = ${studioId}
            AND b.user_id = ${userId}
            AND b.status IN (${CREDIT_CONSUMING_BOOKING_STATUS_SQL})
            AND sc.starts_at >= ${periodStart}
            AND sc.starts_at < ${periodEnd}
          UNION
          SELECT a.scheduled_class_id
          FROM attendances a
          INNER JOIN scheduled_classes sc ON sc.id = a.scheduled_class_id
          WHERE a.studio_id = ${studioId}
            AND a.user_id = ${userId}
            AND sc.starts_at >= ${periodStart}
            AND sc.starts_at < ${periodEnd}
        ) consumed
      `;
      return Number(rows[0]?.count ?? 0n);
    }

    // MM-5.1: scoped counting collapses Booking/Attendance legs into ONE canonical event
    // per class. Explicit attribution is authoritative; each legacy NULL event is assigned
    // to exactly ONE deterministic owner computed from the member's FULL candidate set —
    // so counting different subscriptions independently always agrees, and one legacy
    // event can never land in two ledgers (see legacy-usage-attribution).
    const [legs, candidates] = await Promise.all([
      this.loadConsumptionLegRows(client, studioId, userId, periodStart, periodEnd),
      this.loadOwnershipCandidates(client, studioId, userId),
    ]);
    const { events } = collapseConsumptionRows(legs);
    return events.filter((event) => eventBelongsToSubscription(event, subscriptionId, candidates)).length;
  }

  /** One bounded query: all consuming Booking/Attendance legs in the window, with the
   *  class metadata the ownership rule needs. */
  private async loadConsumptionLegRows(
    client: DbClient,
    studioId: string,
    userId: string,
    periodStart: Date,
    periodEnd: Date,
    scheduledClassId?: string,
  ): Promise<ConsumptionLegRow[]> {
    const classFilterBooking = scheduledClassId
      ? Prisma.sql`AND b.scheduled_class_id = ${scheduledClassId}`
      : Prisma.empty;
    const classFilterAttendance = scheduledClassId
      ? Prisma.sql`AND a.scheduled_class_id = ${scheduledClassId}`
      : Prisma.empty;
    const rows = await client.$queryRaw<
      Array<{
        class_id: string;
        starts_at: Date;
        class_template_id: string;
        category: string | null;
        src: string;
        subscription_id: string | null;
      }>
    >`
      SELECT sc.id AS class_id, sc.starts_at, sc.class_template_id, ct.category::text AS category,
             'booking' AS src, b.subscription_id
      FROM bookings b
      INNER JOIN scheduled_classes sc ON sc.id = b.scheduled_class_id
      INNER JOIN class_templates ct ON ct.id = sc.class_template_id
      WHERE b.studio_id = ${studioId}
        AND b.user_id = ${userId}
        AND b.status IN (${CREDIT_CONSUMING_BOOKING_STATUS_SQL})
        AND sc.starts_at >= ${periodStart}
        AND sc.starts_at < ${periodEnd}
        ${classFilterBooking}
      UNION ALL
      SELECT sc.id AS class_id, sc.starts_at, sc.class_template_id, ct.category::text AS category,
             'attendance' AS src, a.subscription_id
      FROM attendances a
      INNER JOIN scheduled_classes sc ON sc.id = a.scheduled_class_id
      INNER JOIN class_templates ct ON ct.id = sc.class_template_id
      WHERE a.studio_id = ${studioId}
        AND a.user_id = ${userId}
        AND sc.starts_at >= ${periodStart}
        AND sc.starts_at < ${periodEnd}
        ${classFilterAttendance}
    `;
    return rows.map((r) => ({
      classId: r.class_id,
      startsAt: r.starts_at,
      classTemplateId: r.class_template_id,
      templateCategory: r.category,
      source: r.src === 'booking' ? ('booking' as const) : ('attendance' as const),
      subscriptionId: r.subscription_id,
    }));
  }

  /** One bounded query: the member's full ownership-candidate set with plan access data. */
  private async loadOwnershipCandidates(
    client: DbClient,
    studioId: string,
    userId: string,
  ): Promise<LegacyOwnershipCandidate[]> {
    const subs = await client.subscription.findMany({
      where: { studioId, userId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        entitlementEndsAt: true,
        membershipPlan: {
          select: {
            classCredits: true,
            allClassesAccess: true,
            allowedCategories: true,
            classTemplateAccess: { select: { classTemplateId: true } },
          },
        },
      },
    });
    return subs.map((s) => ({
      id: s.id,
      status: s.status,
      createdAt: s.createdAt,
      currentPeriodStart: s.currentPeriodStart,
      currentPeriodEnd: s.currentPeriodEnd,
      entitlementEndsAt: s.entitlementEndsAt,
      membershipPlan: {
        classCredits: s.membershipPlan.classCredits,
        allClassesAccess: s.membershipPlan.allClassesAccess,
        allowedCategories: s.membershipPlan.allowedCategories as string[],
        allowedTemplateIds: s.membershipPlan.classTemplateAccess.map((a) => a.classTemplateId),
      },
    }));
  }

  async isClassConsumedInPeriod(
    client: DbClient,
    studioId: string,
    userId: string,
    scheduledClassId: string,
    periodStart: Date,
    periodEnd: Date,
    subscriptionId?: string | null,
  ): Promise<boolean> {
    if (subscriptionId == null) {
      const rows = await client.$queryRaw<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM (
            SELECT b.scheduled_class_id
            FROM bookings b
            INNER JOIN scheduled_classes sc ON sc.id = b.scheduled_class_id
            WHERE b.studio_id = ${studioId}
              AND b.user_id = ${userId}
              AND b.scheduled_class_id = ${scheduledClassId}
              AND b.status IN (${CREDIT_CONSUMING_BOOKING_STATUS_SQL})
              AND sc.starts_at >= ${periodStart}
              AND sc.starts_at < ${periodEnd}
            UNION
            SELECT a.scheduled_class_id
            FROM attendances a
            INNER JOIN scheduled_classes sc ON sc.id = a.scheduled_class_id
            WHERE a.studio_id = ${studioId}
              AND a.user_id = ${userId}
              AND a.scheduled_class_id = ${scheduledClassId}
              AND sc.starts_at >= ${periodStart}
              AND sc.starts_at < ${periodEnd}
          ) consumed
        ) AS exists
      `;
      return Boolean(rows[0]?.exists);
    }

    // MM-5.1: same canonical-event + deterministic-owner rule as countConsumedClasses —
    // the two must agree so idempotent re-checks and counting can never diverge.
    const [legs, candidates] = await Promise.all([
      this.loadConsumptionLegRows(client, studioId, userId, periodStart, periodEnd, scheduledClassId),
      this.loadOwnershipCandidates(client, studioId, userId),
    ]);
    const { events } = collapseConsumptionRows(legs);
    return events.some((event) => eventBelongsToSubscription(event, subscriptionId, candidates));
  }

  async getUsageForPeriod(
    client: DbClient,
    studioId: string,
    userId: string,
    period: BillingPeriodBounds,
    classCredits: number | null,
    subscriptionId?: string | null,
  ): Promise<MembershipUsageSnapshot> {
    if (classCredits === null) {
      return {
        classCredits: null,
        creditsUsed: 0,
        creditsRemaining: null,
        period,
      };
    }

    const creditsUsed = await this.countConsumedClasses(
      client,
      studioId,
      userId,
      period.start,
      period.end,
      subscriptionId,
    );
    return {
      classCredits,
      creditsUsed,
      creditsRemaining: Math.max(classCredits - creditsUsed, 0),
      period,
    };
  }

  /**
   * Ensures registering attendance or creating a booking would not exceed plan
   * credits. Idempotent when the class is already consumed (booking + attendance
   * dedupe to one credit).
   */
  async assertCreditAvailableForClass(
    client: DbClient,
    studioId: string,
    userId: string,
    scheduledClassId: string,
    classStartsAt: Date,
    subscription: {
      id?: string;
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
      membershipPlan: { classCredits: number | null; entitlementDays?: number | null };
    },
    options?: { errorType?: 'forbidden' | 'bad_request' },
  ): Promise<void> {
    const { classCredits } = subscription.membershipPlan;
    if (classCredits === null) {
      return;
    }

    const storedCycle = subscription.id
      ? await client.membershipEntitlementCycle.findFirst({
          where: {
            subscriptionId: subscription.id,
            startsAt: { lte: classStartsAt },
            endsAt: { gt: classStartsAt },
          },
          orderBy: { startsAt: 'desc' },
        })
      : null;
    if (subscription.id && subscription.membershipPlan.entitlementDays && !storedCycle) {
      throw new ForbiddenException('No paid entitlement cycle covers this class');
    }
    const period = storedCycle
      ? { start: storedCycle.startsAt, end: storedCycle.endsAt }
      : this.resolveBillingPeriodForClassDate(subscription, classStartsAt);
    if (!period) {
      return;
    }

    const alreadyConsumed = await this.isClassConsumedInPeriod(
      client,
      studioId,
      userId,
      scheduledClassId,
      period.start,
      period.end,
      subscription.id ?? null,
    );
    if (alreadyConsumed) {
      return;
    }

    const used = await this.countConsumedClasses(
      client,
      studioId,
      userId,
      period.start,
      period.end,
      subscription.id ?? null,
    );
    if (used >= classCredits) {
      const err =
        options?.errorType === 'bad_request'
          ? new BadRequestException(MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE)
          : new ForbiddenException(MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE);
      throw err;
    }
  }
}
