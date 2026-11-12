import { getStudioLocalHHmm } from '../common/date/studio-local-date';

/**
 * Open Gym door policy, expressed as pure functions over already-loaded data so the decision
 * is unit-testable without a database and identical wherever it is asked.
 *
 * Entitlement is read exclusively from structured MembershipPlan fields (openGymAccess and its
 * optional window) — the Open Gym toggle in Admin. Plan `description` copy is never parsed.
 *
 * This is the ONE Open Gym policy. It governs every way Open Gym can be reached:
 *   - door access with no reservation (CheckInType.OPEN_GYM), evaluated at the scan instant;
 *   - scheduled Open Gym slots (ClassTemplate.isOpenGymSlot): booking, waitlist, walk-in
 *     attendance and booking check-in, evaluated at the slot's start;
 *   - what the member app shows (GET /me/open-gym).
 * A template flag only says "this class IS Open Gym"; whether a plan INCLUDES Open Gym is a
 * per-plan decision, because door hours differ per plan.
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
 * Whether a single plan grants Open Gym at an instant: openGymAccess AND the instant falls in
 * the plan's studio-local window (no window = no hour restriction). Used to decide Open Gym
 * slot bookings at the slot's start time with the same rule the door applies at scan time.
 */
export function planGrantsOpenGymAt(
  plan: Pick<OpenGymPlanPolicy, 'openGymAccess' | 'openGymWindowStart' | 'openGymWindowEnd'>,
  at: Date,
  timezone: string,
): boolean {
  if (!plan.openGymAccess) return false;
  return isWithinOpenGymWindow(
    getStudioLocalHHmm(at, timezone),
    plan.openGymWindowStart,
    plan.openGymWindowEnd,
  );
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

/** What the member app may show about Open Gym. Time-independent: "is it in my plan?". */
export type OpenGymEntitlementSummary = {
  /** True only when a currently-entitled plan has openGymAccess saved as enabled. */
  included: boolean;
  /** The most permissive entitling plan; null when not included. */
  membershipPlanName: string | null;
  /** Studio-local 'HH:mm'; both null when not included OR included without hour limits. */
  windowStart: string | null;
  windowEnd: string | null;
};

/**
 * Collapses the member's currently-entitled plans into the single answer the app needs to
 * decide whether ANY Open Gym UI is shown. Same inputs and same plan ordering as the door,
 * so the app can never advertise Open Gym to someone the door would refuse as not_included.
 */
export function summarizeOpenGymEntitlement(
  entitledPlans: OpenGymPlanPolicy[],
): OpenGymEntitlementSummary {
  const best = entitledPlans.filter((p) => p.openGymAccess).sort(byMostPermissive)[0];
  if (!best) {
    return { included: false, membershipPlanName: null, windowStart: null, windowEnd: null };
  }
  return {
    included: true,
    membershipPlanName: best.membershipPlanName,
    windowStart: best.openGymWindowStart,
    windowEnd: best.openGymWindowEnd,
  };
}
