import { ClassCategory } from '@prisma/client';
import {
  buildPlanClassAccessDto,
  dedupeTemplateIds,
  formatPlanAccessSummary,
  isClassIncludedInPlan,
  isClassInPlanClassList,
  normalizeOpenGymPlanConfig,
  validateRestrictedPlanAccess,
} from './membership-plan-class-access.utils';

describe('membership-plan-class-access.utils', () => {
  describe('isClassIncludedInPlan — Open Gym gate', () => {
    const base = {
      allowedTemplateIds: [] as string[],
      allowedCategories: [] as ClassCategory[],
      classTemplateId: 'tpl-open-gym',
      templateCategory: null,
    };

    it('denies an Open Gym slot to an all-classes plan without openGymAccess (the leak)', () => {
      expect(
        isClassIncludedInPlan({
          ...base,
          allClassesAccess: true,
          openGymAccess: false,
          templateIsOpenGymSlot: true,
        }),
      ).toBe(false);
    });

    it('denies an Open Gym slot that is explicitly listed when openGymAccess is false', () => {
      expect(
        isClassIncludedInPlan({
          ...base,
          allClassesAccess: false,
          allowedTemplateIds: ['tpl-open-gym'],
          openGymAccess: false,
          templateIsOpenGymSlot: true,
        }),
      ).toBe(false);
    });

    it('allows an Open Gym slot whenever the plan has openGymAccess, regardless of class list', () => {
      expect(
        isClassIncludedInPlan({
          ...base,
          allClassesAccess: false,
          allowedTemplateIds: ['tpl-strength'],
          openGymAccess: true,
          templateIsOpenGymSlot: true,
        }),
      ).toBe(true);
    });

    it('leaves ordinary classes on the class-list rule, unaffected by openGymAccess', () => {
      const regular = { ...base, classTemplateId: 'tpl-strength', templateIsOpenGymSlot: false };
      expect(
        isClassIncludedInPlan({ ...regular, allClassesAccess: true, openGymAccess: false }),
      ).toBe(true);
      expect(
        isClassIncludedInPlan({
          ...regular,
          allClassesAccess: false,
          allowedTemplateIds: ['tpl-strength'],
          openGymAccess: false,
        }),
      ).toBe(true);
      expect(
        isClassIncludedInPlan({
          ...regular,
          allClassesAccess: false,
          allowedTemplateIds: ['tpl-other'],
          openGymAccess: true,
        }),
      ).toBe(false);
    });
  });

  describe('isClassInPlanClassList', () => {
    it('allows any class when allClassesAccess is true', () => {
      expect(
        isClassInPlanClassList({
          allClassesAccess: true,
          allowedTemplateIds: [],
          allowedCategories: [],
          classTemplateId: 'tpl-1',
          templateCategory: ClassCategory.STRENGTH,
        }),
      ).toBe(true);
    });

    it('allows listed template when restricted by template IDs', () => {
      expect(
        isClassInPlanClassList({
          allClassesAccess: false,
          allowedTemplateIds: ['tpl-1', 'tpl-2', 'tpl-3'],
          allowedCategories: [],
          classTemplateId: 'tpl-2',
          templateCategory: ClassCategory.HIIT,
        }),
      ).toBe(true);
    });

    it('denies unlisted template when restricted by template IDs', () => {
      expect(
        isClassInPlanClassList({
          allClassesAccess: false,
          allowedTemplateIds: ['tpl-1', 'tpl-2'],
          allowedCategories: [],
          classTemplateId: 'tpl-9',
          templateCategory: ClassCategory.STRENGTH,
        }),
      ).toBe(false);
    });

    it('falls back to legacy allowedCategories when no template IDs', () => {
      expect(
        isClassInPlanClassList({
          allClassesAccess: false,
          allowedTemplateIds: [],
          allowedCategories: [ClassCategory.HYROX],
          classTemplateId: 'tpl-hyrox',
          templateCategory: ClassCategory.HYROX,
        }),
      ).toBe(true);

      expect(
        isClassInPlanClassList({
          allClassesAccess: false,
          allowedTemplateIds: [],
          allowedCategories: [ClassCategory.HYROX],
          classTemplateId: 'tpl-strength',
          templateCategory: ClassCategory.STRENGTH,
        }),
      ).toBe(false);
    });

    it('denies when restricted with no templates and no categories', () => {
      expect(
        isClassInPlanClassList({
          allClassesAccess: false,
          allowedTemplateIds: [],
          allowedCategories: [],
          classTemplateId: 'tpl-1',
          templateCategory: ClassCategory.STRENGTH,
        }),
      ).toBe(false);
    });
  });

  describe('validateRestrictedPlanAccess', () => {
    it('allows unrestricted plans', () => {
      expect(() =>
        validateRestrictedPlanAccess({
          allClassesAccess: true,
          classTemplateIds: [],
        }),
      ).not.toThrow();
    });

    it('allows restricted plans with templates', () => {
      expect(() =>
        validateRestrictedPlanAccess({
          allClassesAccess: false,
          classTemplateIds: ['a', 'b', 'c'],
        }),
      ).not.toThrow();
    });

    it('allows an Open-Gym-only restricted plan with no listed classes', () => {
      expect(() =>
        validateRestrictedPlanAccess({
          allClassesAccess: false,
          classTemplateIds: [],
          openGymAccess: true,
        }),
      ).not.toThrow();
    });

    it('allows restricted legacy category-only plans', () => {
      expect(() =>
        validateRestrictedPlanAccess({
          allClassesAccess: false,
          classTemplateIds: [],
          allowedCategories: [ClassCategory.HYROX],
        }),
      ).not.toThrow();
    });

    it('rejects restricted plans with zero templates and zero categories', () => {
      expect(() =>
        validateRestrictedPlanAccess({
          allClassesAccess: false,
          classTemplateIds: [],
          allowedCategories: [],
        }),
      ).toThrow(/at least one class template, allowed category, or Open Gym/i);
    });
  });

  describe('dedupeTemplateIds', () => {
    it('removes duplicates and blanks', () => {
      expect(dedupeTemplateIds(['a', 'a', ' b ', ''])).toEqual(['a', 'b']);
    });
  });

  describe('buildPlanClassAccessDto', () => {
    it('marks deleted templates as inactive', () => {
      const dto = buildPlanClassAccessDto({
        allClassesAccess: false,
        templates: [
          {
            id: 't1',
            name: 'Push',
            durationMinutes: 60,
            deletedAt: null,
            isOpenGymSlot: false,
            accessWindowStart: null,
            accessWindowEnd: null,
          },
          {
            id: 't2',
            name: 'Pull',
            durationMinutes: 45,
            deletedAt: new Date(),
            isOpenGymSlot: false,
            accessWindowStart: null,
            accessWindowEnd: null,
          },
        ],
      });

      expect(dto.allClasses).toBe(false);
      expect(dto.templates[0]?.active).toBe(true);
      expect(dto.templates[1]?.active).toBe(false);
    });
  });

  describe('formatPlanAccessSummary', () => {
    it('shows Todas las clases for unrestricted', () => {
      expect(
        formatPlanAccessSummary({
          allClasses: true,
          templates: [],
        }),
      ).toBe('Todas las clases');
    });

    it('shows count for many templates', () => {
      expect(
        formatPlanAccessSummary({
          allClasses: false,
          templates: [
            { id: '1', name: 'A', durationMinutes: 60, active: true, isOpenGymSlot: false, accessWindowStart: null, accessWindowEnd: null },
            { id: '2', name: 'B', durationMinutes: 60, active: true, isOpenGymSlot: false, accessWindowStart: null, accessWindowEnd: null },
            { id: '3', name: 'C', durationMinutes: 60, active: true, isOpenGymSlot: false, accessWindowStart: null, accessWindowEnd: null },
            { id: '4', name: 'D', durationMinutes: 60, active: true, isOpenGymSlot: false, accessWindowStart: null, accessWindowEnd: null },
          ],
        }),
      ).toBe('4 clases incluidas');
    });
  });
});

describe('normalizeOpenGymPlanConfig', () => {
  it('clears any window when the toggle is off', () => {
    expect(
      normalizeOpenGymPlanConfig({ openGymAccess: false, openGymWindowStart: '11:00', openGymWindowEnd: '22:00' }),
    ).toEqual({ openGymAccess: false, openGymWindowStart: null, openGymWindowEnd: null });
  });

  it('keeps an unrestricted grant as null bounds', () => {
    expect(
      normalizeOpenGymPlanConfig({ openGymAccess: true, openGymWindowStart: null, openGymWindowEnd: null }),
    ).toEqual({ openGymAccess: true, openGymWindowStart: null, openGymWindowEnd: null });
  });

  it('accepts a valid window', () => {
    expect(
      normalizeOpenGymPlanConfig({ openGymAccess: true, openGymWindowStart: '11:00', openGymWindowEnd: '17:00' }),
    ).toEqual({ openGymAccess: true, openGymWindowStart: '11:00', openGymWindowEnd: '17:00' });
  });

  it('rejects half windows, malformed times and empty windows', () => {
    expect(() =>
      normalizeOpenGymPlanConfig({ openGymAccess: true, openGymWindowStart: '11:00', openGymWindowEnd: null }),
    ).toThrow(/inicio y hora de fin/);
    expect(() =>
      normalizeOpenGymPlanConfig({ openGymAccess: true, openGymWindowStart: '9:00', openGymWindowEnd: '17:00' }),
    ).toThrow(/HH:mm/);
    expect(() =>
      normalizeOpenGymPlanConfig({ openGymAccess: true, openGymWindowStart: '11:00', openGymWindowEnd: '11:00' }),
    ).toThrow(/misma hora/);
  });
});
