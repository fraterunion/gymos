/**
 * Curated fitness imagery catalog.
 *
 * WHY picsum.photos instead of Unsplash CDN:
 * images.unsplash.com/photo-{id} blocks direct hotlinking from mobile apps
 * (returns 403 without a valid Referer or client_id). picsum.photos is
 * purpose-built as a free placeholder service — no auth, no rate-limiting,
 * HTTPS, follows redirects that React Native Image handles transparently.
 *
 * Swap for studio-branded CDN assets in production.
 */

/** Returns a seeded picsum.photos URL — always resolves to the same photo. */
const P = (seed: string, w = 800, h = 600): string =>
  `https://picsum.photos/seed/${seed}/${w}/${h}`;

export const FitnessImages = {
  strength:    P('gymos-strength'),
  running:     P('gymos-running'),
  yoga:        P('gymos-yoga'),
  hiit:        P('gymos-hiit'),
  cycling:     P('gymos-cycling'),
  boxing:      P('gymos-boxing'),
  pilates:     P('gymos-pilates'),
  recovery:    P('gymos-recovery'),
  mobility:    P('gymos-mobility'),
  performance: P('gymos-performance'),
  gym:         P('gymos-gym'),
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

type ClassImageTemplate = {
  name: string;
  heroImageUrl?: string | null;
  thumbnailImageUrl?: string | null;
};

/** Resolves class imagery using studio URLs when present, else keyword-based fallback. */
export function resolveScheduledClassImageUri(
  template: ClassImageTemplate,
  variant: 'hero' | 'thumbnail' = 'hero',
): string {
  if (variant === 'thumbnail') {
    return (
      template.thumbnailImageUrl ??
      template.heroImageUrl ??
      resolveClassImageUri(template.name)
    );
  }
  return (
    template.heroImageUrl ??
    template.thumbnailImageUrl ??
    resolveClassImageUri(template.name)
  );
}

/** Returns a consistent curated image URI based on the class name. */
export function resolveClassImageUri(className: string): string {
  const lower = className.toLowerCase();
  for (const [cat, kws] of KEYWORD_MAP) {
    if (kws.some((kw) => lower.includes(kw))) {
      return FitnessImages[cat];
    }
  }
  // Default: 'performance' — always returns a valid picsum URL
  return FitnessImages.performance;
}

const COACH_PORTRAITS = [
  P('gymos-coach-a', 400, 400),
  P('gymos-coach-b', 400, 400),
  P('gymos-coach-c', 400, 400),
  P('gymos-coach-d', 400, 400),
  P('gymos-coach-e', 400, 400),
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
