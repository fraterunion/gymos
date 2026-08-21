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
 * Canonical class-access rule used by BookingAccessService.
 * 1. allClassesAccess → allow
 * 2. explicit template IDs → allow if classTemplateId is listed
 * 3. legacy allowedCategories → allow if template category matches
 * 4. otherwise deny
 */
export function isClassIncludedInPlan(input: TemplateAccessCheckInput): boolean {
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
}): void {
  if (input.allClassesAccess) return;

  const hasTemplates = input.classTemplateIds.length > 0;
  const hasCategories = (input.allowedCategories?.length ?? 0) > 0;
  if (!hasTemplates && !hasCategories) {
    throw new Error(
      'Restricted plan must include at least one class template or allowed category.',
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
