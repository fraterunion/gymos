import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  DayPassStatus,
  Prisma,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import {
  getStudioLocalDateKey,
  getStudioLocalHHmm,
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
import { currentlyEntitledSubscriptionWhere } from '../memberships/membership-entitlement';
import { MEMBER_ERRORS } from '../member-facing/member-errors';

const bypassRoles: ReadonlySet<Role> = new Set([
  Role.STAFF,
  Role.INSTRUCTOR,
  Role.ADMIN,
  Role.OWNER,
]);

export const CLASS_TIME_WINDOW_DENIED_MESSAGE = MEMBER_ERRORS.timeWindowDenied;

/**
 * Shared booking access guard used by BookingsService (direct booking) and
 * WaitlistService (waitlist join + promotion). Single canonical path enforcing:
 *   1. Role bypass (STAFF/INSTRUCTOR/ADMIN/OWNER)
 *   2. Time-window enforcement for restricted templates (e.g., Open Gym 10:00–17:00)
 *   3. Subscription class-template access (deny-by-default; allClassesAccess=false)
 *   4. Credit limits (classCredits; uses entitlementEndsAt for fixed-duration plans)
 *   5. Day Pass fallback (explicit allowlist; Booty Lab is NOT in it)
 *
 * Staff manual attendance uses a separate entitlement check with explicit override.
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

    // Always fetch template metadata — needed for time-window and category checks.
    const template = await tx.classTemplate.findUnique({
      where: { id: classTemplateId },
      select: { category: true, isOpenGymSlot: true, accessWindowStart: true, accessWindowEnd: true },
    });

    // Time-window enforcement: applies to all members, before subscription and Day Pass checks.
    // bypassRoles (STAFF/INSTRUCTOR/ADMIN/OWNER) return early above and never reach this check.
    if (template?.accessWindowStart && template.accessWindowEnd) {
      const localHHmm = getStudioLocalHHmm(classStartsAt, studioTimezone);
      if (localHHmm < template.accessWindowStart || localHHmm >= template.accessWindowEnd) {
        throw new ForbiddenException(CLASS_TIME_WINDOW_DENIED_MESSAGE);
      }
    }

    const now = new Date();

    // Find the member's effective subscription: active/trialing, OR cancelled with a
    // valid GymOS entitlement window (fixed-duration products like Booty Lab 45-day).
    const sub = await tx.subscription.findFirst({
      where: {
        userId,
        studioId,
        ...currentlyEntitledSubscriptionWhere(now),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        entitlementEndsAt: true,
        membershipPlan: {
          select: {
            allClassesAccess: true,
            allowedCategories: true,
            classCredits: true,
            entitlementDays: true,
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
        // For fixed-duration plans, entitlementEndsAt is the actual access window end.
        // Use it as the effective period end so credits count across the full entitlement.
        const effectivePeriodEnd = sub.entitlementEndsAt ?? sub.currentPeriodEnd;
        const effectiveSub = {
          ...sub,
          currentPeriodEnd: effectivePeriodEnd,
        };

        if (effectiveSub.currentPeriodStart && effectiveSub.currentPeriodEnd) {
          try {
            await this.membershipUsage.assertCreditAvailableForClass(
              tx,
              studioId,
              userId,
              scheduledClassId,
              classStartsAt,
              effectiveSub,
              { errorType: 'forbidden' },
            );
          } catch (e) {
            if (
              e instanceof ForbiddenException &&
              e.message === MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE
            ) {
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

    // Day Pass fallback.
    // The class template must be in the explicit DayPassClassAccess allowlist.
    // Booty Lab and Open Gym sessions are NOT in this list → Day Pass cannot book them.
    const dayPassEligible = await tx.dayPassClassAccess.findFirst({
      where: { studioId, classTemplateId },
      select: { id: true },
    });

    if (dayPassEligible) {
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
    }

    if (subscriptionRestricted) {
      throw new ForbiddenException(MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE);
    }
    if (creditsExhausted) {
      throw new ForbiddenException(MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE);
    }
    const expiredSubscription = await tx.subscription.findFirst({
      where: {
        userId,
        studioId,
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
        OR: [
          { entitlementEndsAt: { lte: now } },
          { entitlementEndsAt: null, currentPeriodEnd: { lte: now } },
        ],
      },
      select: { id: true },
    });
    if (expiredSubscription) {
      throw new ForbiddenException(MEMBER_ERRORS.membershipExpired);
    }
    throw new ForbiddenException(MEMBER_ERRORS.membershipOrDayPassRequired);
  }
}
