import { ClassCategory } from '@prisma/client';
import {
  buildPlanClassAccessDto,
  dedupeTemplateIds,
  formatPlanAccessSummary,
  isClassIncludedInPlan,
  validateRestrictedPlanAccess,
} from './membership-plan-class-access.utils';

describe('membership-plan-class-access.utils', () => {
  describe('isClassIncludedInPlan', () => {
    it('allows any class when allClassesAccess is true', () => {
      expect(
        isClassIncludedInPlan({
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
        isClassIncludedInPlan({
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
        isClassIncludedInPlan({
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
        isClassIncludedInPlan({
          allClassesAccess: false,
          allowedTemplateIds: [],
          allowedCategories: [ClassCategory.HYROX],
          classTemplateId: 'tpl-hyrox',
          templateCategory: ClassCategory.HYROX,
        }),
      ).toBe(true);

      expect(
        isClassIncludedInPlan({
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
        isClassIncludedInPlan({
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
      ).toThrow(/at least one class template or allowed category/i);
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
          },
          {
            id: 't2',
            name: 'Pull',
            durationMinutes: 45,
            deletedAt: new Date(),
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
            { id: '1', name: 'A', durationMinutes: 60, active: true },
            { id: '2', name: 'B', durationMinutes: 60, active: true },
            { id: '3', name: 'C', durationMinutes: 60, active: true },
            { id: '4', name: 'D', durationMinutes: 60, active: true },
          ],
        }),
      ).toBe('4 clases incluidas');
    });
  });
});
