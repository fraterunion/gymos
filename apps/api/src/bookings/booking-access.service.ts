import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  DayPassStatus,
  Prisma,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import {
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
} from '../common/date/studio-local-date';
import { MembershipUsageService } from '../membership-usage/membership-usage.service';
import {
  MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE,
} from '../membership-usage/membership-usage.constants';
import {
  isClassIncludedInPlan,
  MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE,
} from '../membership-plans/membership-plan-class-access.utils';

const bypassRoles: ReadonlySet<Role> = new Set([
  Role.STAFF,
  Role.INSTRUCTOR,
  Role.ADMIN,
  Role.OWNER,
]);

/**
 * Shared booking access guard used by BookingsService (direct booking) and
 * WaitlistService (waitlist join + promotion). A single canonical path enforcing
 * membership class access (template + legacy category), class credit limits, and
 * Day Pass access.
 *
 * Staff manual attendance bypasses this service entirely.
 *
 * Receives a Prisma transaction client so callers control the transaction
 * boundary — no PrismaService injection needed here.
 */
@Injectable()
export class BookingAccessService {
  constructor(private readonly membershipUsage: MembershipUsageService) {}

  async assertAccess(
    tx: Prisma.TransactionClient,
    studioId: string,
    userId: string,
    membershipRole: Role,
    classStartsAt: Date,
    studioTimezone: string,
    classTemplateId: string,
    scheduledClassId: string,
  ): Promise<void> {
    if (bypassRoles.has(membershipRole)) {
      return;
    }

    const sub = await tx.subscription.findFirst({
      where: {
        userId,
        studioId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        currentPeriodStart: true,
        currentPeriodEnd: true,
        membershipPlan: {
          select: {
            allClassesAccess: true,
            allowedCategories: true,
            classCredits: true,
            classTemplateAccess: {
              select: { classTemplateId: true },
            },
          },
        },
      },
    });

    let subscriptionRestricted = false;
    let creditsExhausted = false;

    if (sub) {
      const { allClassesAccess, allowedCategories, classCredits, classTemplateAccess } =
        sub.membershipPlan;
      const allowedTemplateIds = classTemplateAccess.map((row) => row.classTemplateId);

      const template = await tx.classTemplate.findUnique({
        where: { id: classTemplateId },
        select: { category: true },
      });

      if (
        !isClassIncludedInPlan({
          allClassesAccess,
          allowedTemplateIds,
          allowedCategories,
          classTemplateId,
          templateCategory: template?.category ?? null,
        })
      ) {
        subscriptionRestricted = true;
      }

      if (!subscriptionRestricted && classCredits !== null) {
        if (sub.currentPeriodStart && sub.currentPeriodEnd) {
          try {
            await this.membershipUsage.assertCreditAvailableForClass(
              tx,
              studioId,
              userId,
              scheduledClassId,
              classStartsAt,
              sub,
              { errorType: 'forbidden' },
            );
          } catch (e) {
            if (e instanceof ForbiddenException) {
              creditsExhausted = true;
            } else {
              throw e;
            }
          }
        }
      }

      if (!subscriptionRestricted && !creditsExhausted) {
        return;
      }
    }

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

    if (subscriptionRestricted) {
      throw new ForbiddenException(MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE);
    }
    if (creditsExhausted) {
      throw new ForbiddenException(MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE);
    }
    throw new ForbiddenException('Active membership or Day Pass required to book this class.');
  }
}
