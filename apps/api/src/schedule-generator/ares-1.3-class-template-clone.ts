import {
  ClassCategory,
  IntensityLevel,
  type ClassTemplate,
  type Prisma,
} from '@prisma/client';
import type { NewTemplateDef } from './ares-1.3-schedule-pattern';

/** Defaults when cloning a ClassTemplate — equipment/tags are NOT NULL in production DB. */
export const CLASS_TEMPLATE_ARRAY_DEFAULTS = {
  equipment: [] as string[],
  tags: [] as string[],
};

export const CLASS_TEMPLATE_SCALAR_DEFAULTS = {
  durationMinutes: 60,
  defaultCapacity: 25,
  color: '#64748b',
  category: ClassCategory.STRENGTH,
  intensityLevel: IntensityLevel.HIGH,
  isFeatured: false,
};

export type ClassTemplateCloneSource = Pick<
  ClassTemplate,
  | 'description'
  | 'durationMinutes'
  | 'defaultCapacity'
  | 'color'
  | 'defaultInstructorId'
  | 'intensityLevel'
  | 'category'
  | 'equipment'
  | 'tags'
  | 'heroImageUrl'
  | 'thumbnailImageUrl'
  | 'isFeatured'
  | 'difficultyLabel'
  | 'caloriesEstimateMin'
  | 'caloriesEstimateMax'
  | 'cancellationWindowHours'
  | 'waitlistCapacity'
>;

export function buildClonedClassTemplateData(
  studioId: string,
  def: NewTemplateDef,
  base: ClassTemplateCloneSource | null,
): Prisma.ClassTemplateUncheckedCreateInput {
  return {
    studioId,
    name: def.name,
    description: def.description ?? base?.description ?? null,
    durationMinutes: def.durationMinutes ?? base?.durationMinutes ?? CLASS_TEMPLATE_SCALAR_DEFAULTS.durationMinutes,
    defaultCapacity: base?.defaultCapacity ?? CLASS_TEMPLATE_SCALAR_DEFAULTS.defaultCapacity,
    color: def.color ?? base?.color ?? CLASS_TEMPLATE_SCALAR_DEFAULTS.color,
    defaultInstructorId: base?.defaultInstructorId ?? null,
    intensityLevel: base?.intensityLevel ?? CLASS_TEMPLATE_SCALAR_DEFAULTS.intensityLevel,
    category: base?.category ?? CLASS_TEMPLATE_SCALAR_DEFAULTS.category,
    equipment: base?.equipment?.length ? [...base.equipment] : CLASS_TEMPLATE_ARRAY_DEFAULTS.equipment,
    tags: base?.tags?.length ? [...base.tags] : CLASS_TEMPLATE_ARRAY_DEFAULTS.tags,
    heroImageUrl: base?.heroImageUrl ?? null,
    thumbnailImageUrl: base?.thumbnailImageUrl ?? null,
    isFeatured: base?.isFeatured ?? CLASS_TEMPLATE_SCALAR_DEFAULTS.isFeatured,
    difficultyLabel: base?.difficultyLabel ?? null,
    caloriesEstimateMin: base?.caloriesEstimateMin ?? null,
    caloriesEstimateMax: base?.caloriesEstimateMax ?? null,
    cancellationWindowHours: base?.cancellationWindowHours ?? null,
    waitlistCapacity: base?.waitlistCapacity ?? null,
  };
}
