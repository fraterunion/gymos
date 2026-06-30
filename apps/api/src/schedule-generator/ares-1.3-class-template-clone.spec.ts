import { ClassCategory, IntensityLevel } from '@prisma/client';
import {
  buildClonedClassTemplateData,
  CLASS_TEMPLATE_ARRAY_DEFAULTS,
  type ClassTemplateCloneSource,
} from './ares-1.3-class-template-clone';
import type { NewTemplateDef } from './ares-1.3-schedule-pattern';

describe('buildClonedClassTemplateData', () => {
  const def: NewTemplateDef = {
    name: 'Full Body + Core',
    cloneFrom: 'Full Body',
    description: 'Core-focused full body.',
    durationMinutes: 60,
    color: '#ef4444',
  };

  it('always sets equipment and tags to arrays (never null/undefined)', () => {
    const data = buildClonedClassTemplateData('studio-1', def, null);
    expect(data.equipment).toEqual([]);
    expect(data.tags).toEqual([]);
  });

  it('copies equipment and tags from source when present', () => {
    const base: ClassTemplateCloneSource = {
      equipment: ['barbell', 'mat'],
      tags: ['strength'],
      description: null,
      durationMinutes: 60,
      defaultCapacity: 25,
      color: null,
      defaultInstructorId: null,
      intensityLevel: IntensityLevel.HIGH,
      category: ClassCategory.STRENGTH,
      heroImageUrl: null,
      thumbnailImageUrl: null,
      isFeatured: false,
      difficultyLabel: null,
      caloriesEstimateMin: null,
      caloriesEstimateMax: null,
      cancellationWindowHours: null,
      waitlistCapacity: null,
    };

    const data = buildClonedClassTemplateData('studio-1', def, base);
    expect(data.equipment).toEqual(['barbell', 'mat']);
    expect(data.tags).toEqual(['strength']);
  });

  it('uses empty arrays when source arrays are empty', () => {
    const base: ClassTemplateCloneSource = {
      equipment: [],
      tags: [],
      category: ClassCategory.STRENGTH,
      intensityLevel: IntensityLevel.HIGH,
      defaultCapacity: 25,
      description: null,
      durationMinutes: 60,
      color: null,
      defaultInstructorId: null,
      heroImageUrl: null,
      thumbnailImageUrl: null,
      isFeatured: false,
      difficultyLabel: null,
      caloriesEstimateMin: null,
      caloriesEstimateMax: null,
      cancellationWindowHours: null,
      waitlistCapacity: null,
    };

    const data = buildClonedClassTemplateData('studio-1', def, base);
    expect(data.equipment).toEqual(CLASS_TEMPLATE_ARRAY_DEFAULTS.equipment);
    expect(data.tags).toEqual(CLASS_TEMPLATE_ARRAY_DEFAULTS.tags);
  });
});
