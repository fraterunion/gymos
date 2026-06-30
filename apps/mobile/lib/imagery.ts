/**
 * Curated fitness imagery catalog.
 *
 * Uses pre-resolved fastly.picsum.photos URLs (direct CDN, no redirects).
 * picsum.photos/id/* always 302-redirects to fastly.picsum.photos with an
 * HMAC-signed URL. React Native Image on Android (New Architecture) silently
 * drops cross-domain redirects, so we bypass the redirect by hardcoding the
 * final CDN URL. HMACs are deterministic for a given ID+dimensions pair.
 *
 * To refresh: curl -s -o /dev/null -w "%{url_effective}" -L \
 *   https://picsum.photos/id/{id}/{w}/{h}
 *
 * Swap for studio-branded CDN assets in production.
 */

const CDN = 'https://fastly.picsum.photos/id';

/** Direct fastly CDN URL — no redirect, no HMAC recomputation needed. */
const F = (id: number, w: number, h: number, hmac: string): string =>
  `${CDN}/${id}/${w}/${h}.jpg?hmac=${hmac}`;

export const FitnessImages = {
  strength:    F(880,  800, 600, '4g78d_UnyXS09C1mCJ5m9wp8G17yJfpzlqowe3mdRFo'),
  running:     F(855,  800, 600, 'PJoSQj9I-RCHZWlkSyqGtW38F5T2D1j5rT342kMVKKU'),
  yoga:        F(1081, 800, 600, '8MtGJVhsjYr081FjGNTOU2hhC5c2ZiXoorORtBF08gg'),
  hiit:        F(993,  800, 600, 'DbyAziehuYRkTR3Ppb1OF6vae6ZPh9e4ynCD6LjK0MA'),
  cycling:     F(417,  800, 600, 'Y9zo32hG0jyP9g6sP_w-H9H9NhnNuTeZC2ya-ARSAGY'),
  boxing:      F(933,  800, 600, 'D2Y3HOMjRmTndzjwpL376I1Y8k_GqchYRt3MhePWRZQ'),
  pilates:     F(584,  800, 600, 'a3J2cSrpIrYOJYrPB6m_drWlOrh0_0B10VIHEP0qFoY'),
  recovery:    F(847,  800, 600, '5Jhvo2nRIgMluA_uCSC2vJGjAdJaf3kirlUQxNQdhVs'),
  mobility:    F(809,  800, 600, '0MqoK1DX3h3yfEBkDG_L0mpFec5wst2cv2uTZM-vgr4'),
  performance: F(379,  800, 600, 'VoILu1u3-hY8l-Xug_j7iSLJLEXa3C5pM6-jG-pcDKs'),
  gym:         F(885,  800, 600, 'd2anDUYwtWdsa59OHlVJtw46eDnVBuNrgo2do6ADt3Q'),
} as const;

export type FitnessCategory = keyof typeof FitnessImages;

const KEYWORD_MAP: Array<[FitnessCategory, readonly string[]]> = [
  ['yoga',        ['yoga', 'yin', 'flow', 'vinyasa', 'meditation', 'mindful']],
  ['boxing',      ['box', 'kickbox', 'muay', 'combat', 'punch', 'mma', 'fight']],
  ['running',     ['run', 'cardio', 'sprint', 'jog', 'endurance', 'track', 'hyrox']],
  ['cycling',     ['cycle', 'spin', 'bike', 'indoor cycl']],
  ['pilates',     ['pilates', 'reformer', 'barre', 'ballet']],
  ['hiit',        ['hiit', 'circuit', 'crossfit', 'interval', 'tabata', 'bootcamp', 'boot camp', 'legs + hiit']],
  ['recovery',    ['recover', 'stretch', 'foam roll', 'restore', 'relax', 'sauna']],
  ['mobility',    ['mobility', 'flex', 'movement', 'range of motion', 'dynamic', 'street bars', 'calirox', 'calistenia']],
  ['strength',    [
    'strength', 'weight', 'lift', 'deadlift', 'squat', 'press', 'barbell', 'dumbbell', 'powerl',
    'pull', 'push', 'upperbody', 'legs strength', 'full body', 'full body + core', 'fuerza',
  ]],
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
  F(1011, 400, 400, 'jvBe5mf7uDeDmAW3ktW1MawUOEOejOAaMOCgicg1pbc'),
  F(1027, 400, 400, 't1Jz1JWO1HyWviLQFwnFRbPbLSCYmWoXz11b7Fdpllw'),
  F(1062, 400, 400, 'zaTGri35k94fGnPFBesQ7tRVfjy6BUCtXDFQdWQ3r-k'),
  F(1074, 400, 400, 'eH9O4qH8NQGitzB3QaCq9jrbDZr7KQkaW_w17w0uoGM'),
  F(1084, 400, 400, 'p5dgjkZUR2QflKbKUunO841b9USJ4XJCx2weTSBxZIw'),
];

/** Stable portrait URI derived from the coach's name (deterministic hash). */
export function resolveCoachPortraitUri(firstName: string, lastName = ''): string {
  const name = `${firstName}${lastName}`;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return COACH_PORTRAITS[h % COACH_PORTRAITS.length]!;
}

export type CategoryModule = {
  id: string;
  label: string;
  imageUri: string;
  accent: string;
};

/** ARES Method — official weekly themes for Home "Explorar". */
export const ARES_EXPLORE_MODULES: CategoryModule[] = [
  { id: 'legs-hiit', label: 'Legs + HIIT', imageUri: FitnessImages.hiit, accent: '#7c3aed' },
  { id: 'pull', label: 'Pull', imageUri: FitnessImages.strength, accent: '#0f172a' },
  { id: 'push', label: 'Push', imageUri: FitnessImages.performance, accent: '#c9a227' },
  { id: 'full-body-core', label: 'Full Body + Core', imageUri: FitnessImages.strength, accent: '#ef4444' },
  { id: 'street-bars', label: 'Street Bars', imageUri: FitnessImages.mobility, accent: '#10b981' },
  { id: 'upperbody', label: 'Upperbody', imageUri: FitnessImages.strength, accent: '#d97706' },
];

/** @deprecated Use ARES_EXPLORE_MODULES */
export const CATEGORY_MODULES = ARES_EXPLORE_MODULES;
