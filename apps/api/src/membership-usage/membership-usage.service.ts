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
  ): Promise<number> {
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

  async isClassConsumedInPeriod(
    client: DbClient,
    studioId: string,
    userId: string,
    scheduledClassId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<boolean> {
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

  async getUsageForPeriod(
    client: DbClient,
    studioId: string,
    userId: string,
    period: BillingPeriodBounds,
    classCredits: number | null,
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
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
      membershipPlan: { classCredits: number | null };
    },
    options?: { errorType?: 'forbidden' | 'bad_request' },
  ): Promise<void> {
    const { classCredits } = subscription.membershipPlan;
    if (classCredits === null) {
      return;
    }

    const period = this.resolveBillingPeriodForClassDate(subscription, classStartsAt);
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
