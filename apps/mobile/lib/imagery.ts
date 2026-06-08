/**
 * Curated fitness imagery catalog.
 *
 * Uses stable picsum.photos /id/ URLs (fixed photo IDs) so React Native Image
 * does not depend on /seed/ redirect chains that can fail on some native builds.
 *
 * Swap for studio-branded CDN assets in production.
 */

/** Stable picsum photo ID per fitness category. */
const P = (id: number, w = 800, h = 600): string =>
  `https://picsum.photos/id/${id}/${w}/${h}`;

export const FitnessImages = {
  strength:    P(880),
  running:     P(855),
  yoga:        P(1081),
  hiit:        P(993),
  cycling:     P(417),
  boxing:      P(933),
  pilates:     P(584),
  recovery:    P(847),
  mobility:    P(809),
  performance: P(379),
  gym:         P(885),
} as const;

export type FitnessCategory = keyof typeof FitnessImages;

const KEYWORD_MAP: Array<[FitnessCategory, readonly string[]]> = [
  ['yoga',        ['yoga', 'yin', 'flow', 'vinyasa', 'meditation', 'mindful']],
  ['boxing',      ['box', 'kickbox', 'muay', 'combat', 'punch', 'mma', 'fight']],
  ['running',     ['run', 'cardio', 'sprint', 'jog', 'endurance', 'track']],
  ['cycling',     ['cycle', 'spin', 'bike', 'indoor cycl']],
  ['pilates',     ['pilates', 'reformer', 'barre', 'ballet']],
  ['hiit',        ['hiit', 'circuit', 'crossfit', 'interval', 'tabata', 'bootcamp', 'boot camp']],
  ['recovery',    ['recover', 'stretch', 'foam roll', 'restore', 'relax', 'sauna']],
  ['mobility',    ['mobility', 'flex', 'movement', 'range of motion', 'dynamic']],
  ['strength',    ['strength', 'weight', 'lift', 'deadlift', 'squat', 'press', 'barbell', 'dumbbell', 'powerl']],
];

export type ClassImageTemplate = {
  name: string;
  category?: string | null;
  heroImageUrl?: string | null;
  thumbnailImageUrl?: string | null;
};

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function resolveCuratedFallback(name: string, category?: string | null): string {
  const hints = [category, name].filter(Boolean) as string[];
  for (const hint of hints) {
    const lower = hint.toLowerCase();
    for (const [cat, kws] of KEYWORD_MAP) {
      if (kws.some((kw) => lower.includes(kw))) {
        return FitnessImages[cat];
      }
    }
  }
  return FitnessImages.performance;
}

/** Resolves class imagery: studio URLs first, then keyword/category curated fallback. */
export function resolveScheduledClassImageUri(
  template: ClassImageTemplate,
  variant: 'hero' | 'thumbnail' = 'hero',
): string {
  const studioUri =
    variant === 'thumbnail'
      ? firstNonEmpty(template.thumbnailImageUrl, template.heroImageUrl)
      : firstNonEmpty(template.heroImageUrl, template.thumbnailImageUrl);

  return studioUri ?? resolveCuratedFallback(template.name, template.category);
}

/** Returns a consistent curated image URI based on the class name. */
export function resolveClassImageUri(className: string): string {
  return resolveCuratedFallback(className);
}

const COACH_PORTRAITS = [
  P(1011, 400, 400),
  P(1027, 400, 400),
  P(1062, 400, 400),
  P(1074, 400, 400),
  P(1084, 400, 400),
];

/** Stable portrait URI derived from the coach's name (deterministic hash). */
export function resolveCoachPortraitUri(firstName: string, lastName = ''): string {
  const name = `${firstName}${lastName}`;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return COACH_PORTRAITS[h % COACH_PORTRAITS.length]!;
}

export type CategoryModule = {
  id: FitnessCategory;
  label: string;
  imageUri: string;
  accent: string;
};

export const CATEGORY_MODULES: CategoryModule[] = [
  { id: 'strength',    label: 'Strength',   imageUri: FitnessImages.strength,    accent: '#E87B35' },
  { id: 'running',     label: 'Cardio',     imageUri: FitnessImages.running,     accent: '#3B82F6' },
  { id: 'yoga',        label: 'Yoga',       imageUri: FitnessImages.yoga,        accent: '#8B5CF6' },
  { id: 'hiit',        label: 'HIIT',       imageUri: FitnessImages.hiit,        accent: '#EF4444' },
  { id: 'boxing',      label: 'Boxing',     imageUri: FitnessImages.boxing,      accent: '#F59E0B' },
  { id: 'recovery',    label: 'Recovery',   imageUri: FitnessImages.recovery,    accent: '#10B981' },
];
