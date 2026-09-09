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
import { orderEntitlementCandidates } from '../memberships/membership-compatibility';
import { MEMBER_ERRORS } from '../member-facing/member-errors';

const bypassRoles: ReadonlySet<Role> = new Set([
  Role.STAFF,
  Role.INSTRUCTOR,
  Role.ADMIN,
  Role.OWNER,
]);

export const CLASS_TIME_WINDOW_DENIED_MESSAGE = MEMBER_ERRORS.timeWindowDenied;

export type BookingAccessResult = {
  subscriptionId: string | null;
  /** MM-5: which membership this booking is charged to (null for role bypass / Day Pass). */
  chargedMembership: {
    subscriptionId: string;
    planName: string;
    creditConsumed: boolean;
  } | null;
};

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

  /**
   * MM-2: returns the id of the subscription whose entitlement authorized this access, so
   * callers persist it as Booking.subscriptionId. Null when authorization came from a role
   * bypass or the Day Pass fallback (no membership entitlement was consumed).
   * MM-5: also returns chargedMembership for the booking response — which membership the
   * booking is charged to and whether a scarce credit was consumed (false for unlimited).
   */
  async assertAccess(
    tx: Prisma.TransactionClient,
    studioId: string,
    userId: string,
    membershipRole: Role,
    classStartsAt: Date,
    studioTimezone: string,
    classTemplateId: string,
    scheduledClassId: string,
  ): Promise<BookingAccessResult> {
    if (bypassRoles.has(membershipRole)) {
      return { subscriptionId: null, chargedMembership: null };
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

    // MM-2: load ALL currently entitled memberships (active/trialing, OR cancelled with a
    // valid GymOS entitlement window — fixed-duration products like Booty Lab 45-day) and
    // resolve deterministically instead of picking one arbitrary row.
    const entitledSubs = await tx.subscription.findMany({
      where: {
        userId,
        studioId,
        ...currentlyEntitledSubscriptionWhere(now),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        createdAt: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        entitlementEndsAt: true,
        membershipPlan: {
          select: {
            name: true,
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

    if (entitledSubs.length > 0) {
      // Candidates: only memberships whose plan actually includes this class.
      const qualifying = entitledSubs.filter((sub) =>
        isClassIncludedInPlan({
          allClassesAccess: sub.membershipPlan.allClassesAccess,
          allowedTemplateIds: sub.membershipPlan.classTemplateAccess.map((row) => row.classTemplateId),
          allowedCategories: sub.membershipPlan.allowedCategories,
          classTemplateId,
          templateCategory: template?.category ?? null,
        }),
      );

      if (qualifying.length === 0) {
        subscriptionRestricted = true;
      } else {
        // Canonical precedence (membership-compatibility): unlimited first — never burn
        // scarce credits when an unlimited membership already covers the class; then
        // credit-limited by soonest-ending entitlement; stable tie-breaks.
        const ordered = orderEntitlementCandidates(qualifying);

        let firstNonExhaustedError: ForbiddenException | null = null;
        for (const sub of ordered) {
          if (sub.membershipPlan.classCredits === null) {
            return {
              subscriptionId: sub.id,
              chargedMembership: {
                subscriptionId: sub.id,
                planName: sub.membershipPlan.name,
                creditConsumed: false,
              },
            };
          }

          // For fixed-duration plans, entitlementEndsAt is the actual access window end.
          // Use it as the effective period end so credits count across the full entitlement.
          const effectiveSub = {
            ...sub,
            currentPeriodEnd: sub.entitlementEndsAt ?? sub.currentPeriodEnd,
          };
          if (!effectiveSub.currentPeriodStart || !effectiveSub.currentPeriodEnd) {
            // No resolvable period — cannot meter credits; matches the legacy single-sub
            // behavior of allowing the booking rather than inventing a denial.
            return {
              subscriptionId: sub.id,
              chargedMembership: {
                subscriptionId: sub.id,
                planName: sub.membershipPlan.name,
                creditConsumed: false,
              },
            };
          }
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
            return {
              subscriptionId: sub.id,
              chargedMembership: {
                subscriptionId: sub.id,
                planName: sub.membershipPlan.name,
                creditConsumed: true,
              },
            };
          } catch (e) {
            if (
              e instanceof ForbiddenException &&
              e.message === MEMBERSHIP_CLASS_CREDITS_EXHAUSTED_MESSAGE
            ) {
              creditsExhausted = true;
              continue;
            }
            if (e instanceof ForbiddenException) {
              // e.g. no paid entitlement cycle covers this class — this candidate cannot
              // authorize, but another one still might.
              firstNonExhaustedError = firstNonExhaustedError ?? e;
              continue;
            }
            throw e;
          }
        }

        // No candidate could authorize. Preserve legacy single-membership semantics:
        // a non-exhausted failure (e.g. missing paid cycle) propagates as-is unless an
        // exhausted-credits outcome should win the Day Pass fallback below.
        if (!creditsExhausted && firstNonExhaustedError) {
          throw firstNonExhaustedError;
        }
        if (!creditsExhausted) {
          creditsExhausted = true;
        }
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
      if (pass) return { subscriptionId: null, chargedMembership: null };
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
