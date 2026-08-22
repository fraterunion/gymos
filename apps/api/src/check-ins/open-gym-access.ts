import { getStudioLocalHHmm } from '../common/date/studio-local-date';

/**
 * Open Gym door policy, expressed as pure functions over already-loaded data so the decision
 * is unit-testable without a database and identical wherever it is asked.
 *
 * Entitlement is read exclusively from structured MembershipPlan fields. Plan `description`
 * copy is never parsed, and ClassTemplate.isOpenGymSlot is deliberately not consulted: a class
 * template is one shared object and cannot express per-plan hours (at ARES, Basic and Full
 * Access allow 11:00-22:00 while the Open Gym plan allows 11:00-17:00).
 */

export type OpenGymPlanPolicy = {
  membershipPlanId: string;
  membershipPlanName: string;
  openGymAccess: boolean;
  /** Studio-local 'HH:mm'. Null (both bounds) means the plan has no hour restriction. */
  openGymWindowStart: string | null;
  openGymWindowEnd: string | null;
};

export type OpenGymEligibility =
  | {
      outcome: 'allowed';
      membershipPlanId: string;
      membershipPlanName: string;
      windowStart: string | null;
      windowEnd: string | null;
    }
  | {
      /** Entitled membership exists, but no plan on it grants Open Gym. */
      outcome: 'not_included';
    }
  | {
      /** A plan grants Open Gym, but not at this local time. */
      outcome: 'outside_hours';
      membershipPlanName: string;
      windowStart: string;
      windowEnd: string;
      /** Studio-local 'HH:mm' the decision was made against. */
      localTime: string;
    }
  | {
      /** No currently-entitled subscription at all. */
      outcome: 'not_entitled';
    };

/**
 * Half-open interval [start, end) on zero-padded 24-hour 'HH:mm' strings, which compare
 * correctly with lexicographic ordering. Half-open means an end of '22:00' denies 22:00 exactly,
 * so two adjacent windows can never both match the same minute.
 *
 * A window whose end is not after its start is read as crossing midnight (e.g. '22:00'-'06:00')
 * rather than as an error, so a studio configuring late-night access gets the obvious behaviour
 * instead of a lockout. An empty window (start === end) matches nothing.
 */
export function isWithinOpenGymWindow(
  localHHmm: string,
  windowStart: string | null,
  windowEnd: string | null,
): boolean {
  if (windowStart === null || windowEnd === null) {
    return true;
  }
  if (windowStart === windowEnd) {
    return false;
  }
  if (windowStart < windowEnd) {
    return localHHmm >= windowStart && localHHmm < windowEnd;
  }
  return localHHmm >= windowStart || localHHmm < windowEnd;
}

/**
 * Deterministic ordering for the (rare) case of a member holding several entitled
 * subscriptions: widest window first, so the plan most likely to admit them is evaluated
 * first and is also the one named if every plan refuses. Plan name breaks ties so the same
 * inputs always produce the same message.
 */
function byMostPermissive(a: OpenGymPlanPolicy, b: OpenGymPlanPolicy): number {
  const aUnrestricted = a.openGymWindowStart === null;
  const bUnrestricted = b.openGymWindowStart === null;
  if (aUnrestricted !== bUnrestricted) {
    return aUnrestricted ? -1 : 1;
  }
  if (a.openGymWindowStart !== b.openGymWindowStart) {
    return (a.openGymWindowStart ?? '').localeCompare(b.openGymWindowStart ?? '');
  }
  if (a.openGymWindowEnd !== b.openGymWindowEnd) {
    return (b.openGymWindowEnd ?? '').localeCompare(a.openGymWindowEnd ?? '');
  }
  return a.membershipPlanName.localeCompare(b.membershipPlanName);
}

/**
 * @param entitledPlans Plans from the member's CURRENTLY-ENTITLED subscriptions only. An
 *   expired or paused subscription must be filtered out by the caller, not passed here —
 *   this function reads an empty list as "no valid membership".
 * @param now          Absolute instant of the scan.
 * @param timezone     IANA zone from Studio.timezone. Never the server's or device's zone.
 */
export function evaluateOpenGymEligibility(
  entitledPlans: OpenGymPlanPolicy[],
  now: Date,
  timezone: string,
): OpenGymEligibility {
  if (entitledPlans.length === 0) {
    return { outcome: 'not_entitled' };
  }

  const openGymPlans = entitledPlans.filter((p) => p.openGymAccess).sort(byMostPermissive);
  if (openGymPlans.length === 0) {
    return { outcome: 'not_included' };
  }

  const localHHmm = getStudioLocalHHmm(now, timezone);

  for (const plan of openGymPlans) {
    if (isWithinOpenGymWindow(localHHmm, plan.openGymWindowStart, plan.openGymWindowEnd)) {
      return {
        outcome: 'allowed',
        membershipPlanId: plan.membershipPlanId,
        membershipPlanName: plan.membershipPlanName,
        windowStart: plan.openGymWindowStart,
        windowEnd: plan.openGymWindowEnd,
      };
    }
  }

  // Every Open Gym plan refused on hours. A plan with a null window can never reach here
  // (isWithinOpenGymWindow always admits it), so the bounds below are always present.
  const named = openGymPlans[0]!;
  return {
    outcome: 'outside_hours',
    membershipPlanName: named.membershipPlanName,
    windowStart: named.openGymWindowStart!,
    windowEnd: named.openGymWindowEnd!,
    localTime: localHHmm,
  };
}
