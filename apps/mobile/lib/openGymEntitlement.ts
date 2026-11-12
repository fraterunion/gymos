/**
 * Member-app Open Gym visibility. The API decides entitlement (GET /members/me → `openGym`,
 * computed from the plan's saved Open Gym toggle); this module only applies that answer to UI.
 *
 * Fail-closed on purpose: no profile yet, a failed request, a guest, or an API too old to
 * send `openGym` all mean "show no Open Gym UI". Showing Open Gym to someone the door refuses
 * is the bug; briefly hiding it from someone entitled is harmless and self-corrects on the
 * next profile load. Access itself is always enforced server-side, never here.
 */

export type OpenGymEntitlementDto = {
  included: boolean;
  membershipPlanName: string | null;
  /** Studio-local 'HH:mm'; both null when included without hour restriction. */
  windowStart: string | null;
  windowEnd: string | null;
};

export const NO_OPEN_GYM: OpenGymEntitlementDto = {
  included: false,
  membershipPlanName: null,
  windowStart: null,
  windowEnd: null,
};

/** Normalizes whatever the profile carried into a definite answer (absent ⇒ not included). */
export function resolveOpenGymEntitlement(
  profile: { openGym?: Partial<OpenGymEntitlementDto> | null } | null | undefined,
): OpenGymEntitlementDto {
  const og = profile?.openGym;
  if (!og || og.included !== true) return NO_OPEN_GYM;
  const windowStart = typeof og.windowStart === 'string' ? og.windowStart : null;
  const windowEnd = typeof og.windowEnd === 'string' ? og.windowEnd : null;
  return {
    included: true,
    membershipPlanName: typeof og.membershipPlanName === 'string' ? og.membershipPlanName : null,
    windowStart: windowStart && windowEnd ? windowStart : null,
    windowEnd: windowStart && windowEnd ? windowEnd : null,
  };
}

/**
 * Hides scheduled Open Gym slots from members without Open Gym. Every other class is kept —
 * this must never hide a legitimate class.
 */
export function filterOpenGymSlots<T extends { classTemplate: { isOpenGymSlot?: boolean } }>(
  classes: readonly T[],
  entitlement: Pick<OpenGymEntitlementDto, 'included'>,
): T[] {
  if (entitlement.included) return [...classes];
  return classes.filter((c) => c.classTemplate.isOpenGymSlot !== true);
}

/** Whether an Open Gym slot is included for this member (non-Open-Gym classes: not decided here). */
export function isOpenGymSlotIncluded(
  classTemplate: { isOpenGymSlot?: boolean },
  entitlement: Pick<OpenGymEntitlementDto, 'included'>,
): boolean {
  return classTemplate.isOpenGymSlot !== true || entitlement.included;
}

/** '11:00' → '11:00 AM'. Mirrors the Front Desk formatter so members and staff read the same hours. */
function formatHour(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(':');
  const hour = Number(hStr);
  if (!Number.isFinite(hour)) return hhmm;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${mStr ?? '00'} ${suffix}`;
}

/**
 * Card headline for an entitled member. A plan with its own window shows THAT window — the
 * hours the door actually enforces for them. A plan without one keeps the studio's published
 * Open Gym label.
 */
export function openGymCardTitle(entitlement: OpenGymEntitlementDto, studioDefaultLabel: string): string {
  if (entitlement.windowStart && entitlement.windowEnd) {
    return `Open Gym · ${formatHour(entitlement.windowStart)} – ${formatHour(entitlement.windowEnd)}`;
  }
  return studioDefaultLabel;
}
