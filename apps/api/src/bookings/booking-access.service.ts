import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  BookingStatus,
  DayPassStatus,
  Prisma,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import {
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
} from '../common/date/studio-local-date';

const bypassRoles: ReadonlySet<Role> = new Set([
  Role.STAFF,
  Role.INSTRUCTOR,
  Role.ADMIN,
  Role.OWNER,
]);

/**
 * Shared booking access guard used by BookingsService (direct booking) and
 * WaitlistService (waitlist join). A single canonical path enforcing membership
 * category restrictions, class credit limits, and Day Pass access.
 *
 * Receives a Prisma transaction client so callers control the transaction
 * boundary — no PrismaService injection needed here.
 */
@Injectable()
export class BookingAccessService {
  async assertAccess(
    tx: Prisma.TransactionClient,
    studioId: string,
    userId: string,
    membershipRole: Role,
    classStartsAt: Date,
    studioTimezone: string,
    classTemplateId: string,
  ): Promise<void> {
    if (bypassRoles.has(membershipRole)) {
      return;
    }

    // Gate 1: active or trialing subscription.
    // currentPeriodStart/End fetched here for the credit check below.
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

    // Denial flags — mutually exclusive, both deferred past Gate 2 so a Day
    // Pass can override either. subscriptionRestricted fires when category
    // doesn't match (credit check skipped). creditsExhausted fires when
    // category passes but all credits for the billing period are spent.
    let subscriptionRestricted = false;
    let creditsExhausted = false;

    if (sub) {
      const { allowedCategories, classCredits } = sub.membershipPlan;

      // ── Category check ─────────────────────────────────────────────────────
      if (allowedCategories.length > 0) {
        const template = await tx.classTemplate.findUnique({
          where: { id: classTemplateId },
          select: { category: true },
        });

        if (!template?.category || !allowedCategories.includes(template.category)) {
          subscriptionRestricted = true;
        }
      }

      // ── Credit check (only when category passed) ───────────────────────────
      if (!subscriptionRestricted && classCredits !== null) {
        // Both period bounds must be present to enforce credits accurately.
        // When either is missing (legacy subscription without a known billing
        // window) skip enforcement rather than produce a false denial.
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
            creditsExhausted = true;
          }
        }
      }

      // All Gate 1 checks passed — allow.
      if (!subscriptionRestricted && !creditsExhausted) {
        return;
      }
    }

    // Gate 2: active Day Pass for the class's studio-local calendar date.
    // validForDate is the UTC anchor for local midnight in the studio timezone.
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
