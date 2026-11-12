import { ClassCategory } from '@prisma/client';
import { MEMBER_ERRORS } from '../member-facing/member-errors';

export const MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE = MEMBER_ERRORS.planRestricted;

export type PlanClassAccessInput = {
  allClassesAccess: boolean;
  allowedTemplateIds: string[];
  allowedCategories: ClassCategory[];
};

export type TemplateAccessCheckInput = PlanClassAccessInput & {
  classTemplateId: string;
  templateCategory: ClassCategory | null;
};

/**
 * Authorization input: the class list PLUS the plan's Open Gym entitlement. Both Open Gym
 * fields are required on purpose — a caller that forgets them fails to compile instead of
 * silently treating an Open Gym slot as an ordinary class.
 */
export type ClassAuthorizationInput = TemplateAccessCheckInput & {
  /** MembershipPlan.openGymAccess — the only authority for Open Gym in any form. */
  openGymAccess: boolean;
  /** ClassTemplate.isOpenGymSlot of the class being decided. */
  templateIsOpenGymSlot: boolean;
};

/**
 * Canonical class-access rule for every AUTHORIZATION decision (booking, waitlist, walk-in
 * attendance, and every surface that tells someone whether a plan includes a class).
 *
 * Open Gym slots (ClassTemplate.isOpenGymSlot) are decided ONLY by the plan's saved
 * openGymAccess flag — never by allClassesAccess, the explicit template list or categories.
 * That is the Open Gym toggle in Admin, so turning it off removes Open Gym from the plan
 * everywhere, and "Todas las clases" can no longer smuggle Open Gym into a plan that does
 * not include it. Hour windows are time-dependent and checked separately by callers that
 * know the instant (see planGrantsOpenGymAt).
 *
 * Every other class follows the class list (isClassInPlanClassList).
 */
export function isClassIncludedInPlan(input: ClassAuthorizationInput): boolean {
  if (input.templateIsOpenGymSlot) return input.openGymAccess === true;
  return isClassInPlanClassList(input);
}

/**
 * The plan's class LIST only, ignoring Open Gym entitlement:
 * 1. allClassesAccess → allow
 * 2. explicit template IDs → allow if classTemplateId is listed
 * 3. legacy allowedCategories → allow if template category matches
 * 4. otherwise deny
 *
 * NOT an authorization decision. Kept for historical credit-ledger attribution
 * (legacy-usage-attribution), which must keep attributing past events exactly as it always
 * has. Anything deciding whether a member may enter or book uses isClassIncludedInPlan.
 */
export function isClassInPlanClassList(input: TemplateAccessCheckInput): boolean {
  if (input.allClassesAccess) return true;

  if (input.allowedTemplateIds.length > 0) {
    return input.allowedTemplateIds.includes(input.classTemplateId);
  }

  if (input.allowedCategories.length > 0) {
    return (
      input.templateCategory != null &&
      input.allowedCategories.includes(input.templateCategory)
    );
  }

  return false;
}

export function dedupeTemplateIds(ids: string[] | undefined): string[] {
  if (!ids?.length) return [];
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

export function validateRestrictedPlanAccess(input: {
  allClassesAccess: boolean;
  classTemplateIds: string[];
  allowedCategories?: ClassCategory[];
  /** An Open-Gym-only plan grants access without listing any class. */
  openGymAccess?: boolean;
}): void {
  if (input.allClassesAccess) return;

  const hasTemplates = input.classTemplateIds.length > 0;
  const hasCategories = (input.allowedCategories?.length ?? 0) > 0;
  if (!hasTemplates && !hasCategories && input.openGymAccess !== true) {
    throw new Error(
      'Restricted plan must include at least one class template, allowed category, or Open Gym.',
    );
  }
}

export type ClassAccessTemplateDto = {
  id: string;
  name: string;
  durationMinutes: number;
  active: boolean;
  isOpenGymSlot: boolean;
  accessWindowStart: string | null;
  accessWindowEnd: string | null;
};

export type PlanClassAccessDto = {
  allClasses: boolean;
  templates: ClassAccessTemplateDto[];
};

export function buildPlanClassAccessDto(input: {
  allClassesAccess: boolean;
  templates: Array<{
    id: string;
    name: string;
    durationMinutes: number;
    deletedAt: Date | null;
    isOpenGymSlot: boolean;
    accessWindowStart: string | null;
    accessWindowEnd: string | null;
  }>;
}): PlanClassAccessDto {
  return {
    allClasses: input.allClassesAccess,
    templates: input.templates.map((t) => ({
      id: t.id,
      name: t.name,
      durationMinutes: t.durationMinutes,
      active: t.deletedAt == null,
      isOpenGymSlot: t.isOpenGymSlot,
      accessWindowStart: t.accessWindowStart,
      accessWindowEnd: t.accessWindowEnd,
    })),
  };
}

export function formatPlanAccessSummary(classAccess: PlanClassAccessDto): string {
  if (classAccess.allClasses) return 'Todas las clases';
  if (classAccess.templates.length === 0) return 'Acceso restringido';
  if (classAccess.templates.length <= 3) {
    return classAccess.templates.map((t) => t.name).join(', ');
  }
  return `${classAccess.templates.length} clases incluidas`;
}

/** Zero-padded 24-hour 'HH:mm', the format the Open Gym window comparison relies on. */
export const OPEN_GYM_HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type OpenGymPlanConfig = {
  openGymAccess: boolean;
  openGymWindowStart: string | null;
  openGymWindowEnd: string | null;
};

/**
 * Normalizes the Admin's Open Gym toggle + optional window into the three states the schema
 * documents, or throws with a message suitable for a 400:
 *   access off            -> window cleared (an off toggle never keeps stale hours)
 *   access on, no window  -> unrestricted
 *   access on, window     -> both bounds, valid 'HH:mm', not empty (start === end matches nothing)
 * A start later than the end is a window crossing midnight, as the door policy reads it.
 */
export function normalizeOpenGymPlanConfig(input: OpenGymPlanConfig): OpenGymPlanConfig {
  if (!input.openGymAccess) {
    return { openGymAccess: false, openGymWindowStart: null, openGymWindowEnd: null };
  }
  const start = input.openGymWindowStart?.trim() || null;
  const end = input.openGymWindowEnd?.trim() || null;
  if (start === null && end === null) {
    return { openGymAccess: true, openGymWindowStart: null, openGymWindowEnd: null };
  }
  if (start === null || end === null) {
    throw new Error('El horario de Open Gym requiere hora de inicio y hora de fin.');
  }
  if (!OPEN_GYM_HHMM_PATTERN.test(start) || !OPEN_GYM_HHMM_PATTERN.test(end)) {
    throw new Error('El horario de Open Gym debe usar el formato HH:mm (24 horas).');
  }
  if (start === end) {
    throw new Error('El horario de Open Gym no puede iniciar y terminar a la misma hora.');
  }
  return { openGymAccess: true, openGymWindowStart: start, openGymWindowEnd: end };
}
