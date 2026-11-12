import { DayPassStatus, Prisma, Role } from '@prisma/client';
import {
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
} from '../common/date/studio-local-date';
import { currentlyEntitledSubscriptionWhere } from '../memberships/membership-entitlement';
import { evaluateOpenGymEligibility, type OpenGymEligibility, type OpenGymPlanPolicy } from './open-gym-access';

type SubscriptionReader = Pick<Prisma.TransactionClient, 'subscription'>;
type SlotAccessReader = Pick<
  Prisma.TransactionClient,
  'subscription' | 'studioMembership' | 'dayPassClassAccess' | 'dayPass'
>;

/**
 * Roles that are never metered by membership entitlement, matching BookingAccessService's
 * bypass set. Their reservations were authorized by role, so their check-ins are too.
 */
const OPEN_GYM_ROLE_BYPASS: ReadonlySet<Role> = new Set([
  Role.STAFF,
  Role.INSTRUCTOR,
  Role.ADMIN,
  Role.OWNER,
]);

/**
 * Open Gym policy for every subscription the member is currently entitled under, using the
 * same `currentlyEntitledSubscriptionWhere` predicate as booking access — so "expired",
 * "paused", "scheduled" and "cancelled but still inside a paid entitlement window" mean
 * exactly what they mean everywhere else. Read from the database on every decision: there is
 * no cached entitlement, so an Admin toggle change applies to the very next request.
 *
 * An empty result means "no valid membership", never "no Open Gym".
 */
export async function loadOpenGymPlanPolicies(
  db: SubscriptionReader,
  studioId: string,
  userId: string,
  now: Date,
): Promise<OpenGymPlanPolicy[]> {
  const subscriptions = await db.subscription.findMany({
    where: { studioId, userId, ...currentlyEntitledSubscriptionWhere(now) },
    orderBy: { createdAt: 'asc' },
    select: {
      membershipPlan: {
        select: {
          id: true,
          name: true,
          openGymAccess: true,
          openGymWindowStart: true,
          openGymWindowEnd: true,
        },
      },
    },
  });

  return subscriptions.map((s) => ({
    membershipPlanId: s.membershipPlan.id,
    membershipPlanName: s.membershipPlan.name,
    openGymAccess: s.membershipPlan.openGymAccess,
    openGymWindowStart: s.membershipPlan.openGymWindowStart,
    openGymWindowEnd: s.membershipPlan.openGymWindowEnd,
  }));
}

export type OpenGymSlotAccess =
  | { outcome: 'allowed'; via: 'role' | 'membership' | 'day_pass' }
  | Exclude<OpenGymEligibility, { outcome: 'allowed' }>;

/**
 * May this member attend a SCHEDULED Open Gym slot (ClassTemplate.isOpenGymSlot) right now?
 *
 * Asked again at check-in — not only at booking — because an Open Gym reservation is a claim
 * on an entitlement, and that entitlement can be withdrawn after the reservation was made
 * (Admin toggle turned off, membership expired, cancelled or paused). The reservation itself
 * is preserved untouched; it simply stops admitting anyone the policy no longer covers.
 *
 *   - Membership entitlement is evaluated NOW (is the subscription still valid?), and the
 *     plan's Open Gym hours against the SLOT START (the session the member reserved).
 *   - Staff roles pass, exactly as they do at booking.
 *   - A Day Pass passes only when the Admin's Day Pass allowlist includes this template and
 *     the pass is valid for the slot's studio-local date — the same rule booking applies.
 */
export async function evaluateOpenGymSlotAccess(
  db: SlotAccessReader,
  input: {
    studioId: string;
    userId: string;
    classTemplateId: string;
    slotStartsAt: Date;
    timezone: string;
    now: Date;
  },
): Promise<OpenGymSlotAccess> {
  const { studioId, userId, classTemplateId, slotStartsAt, timezone, now } = input;

  const membership = await db.studioMembership.findFirst({
    where: { studioId, userId, deletedAt: null },
    select: { role: true },
  });
  if (membership && OPEN_GYM_ROLE_BYPASS.has(membership.role)) {
    return { outcome: 'allowed', via: 'role' };
  }

  const plans = await loadOpenGymPlanPolicies(db, studioId, userId, now);
  const eligibility = evaluateOpenGymEligibility(plans, slotStartsAt, timezone);
  if (eligibility.outcome === 'allowed') {
    return { outcome: 'allowed', via: 'membership' };
  }

  const dayPassAllowlisted = await db.dayPassClassAccess.findFirst({
    where: { studioId, classTemplateId },
    select: { id: true },
  });
  if (dayPassAllowlisted) {
    const dateKey = getStudioLocalDateKey(slotStartsAt, timezone);
    const pass = await db.dayPass.findFirst({
      where: {
        studioId,
        userId,
        status: DayPassStatus.ACTIVE,
        validForDate: studioLocalDateKeyToUtcAnchor(dateKey, timezone),
      },
      select: { id: true },
    });
    if (pass) return { outcome: 'allowed', via: 'day_pass' };
  }

  return eligibility;
}
