/**
 * Curated fitness imagery catalog.
 * All photos are royalty-free (Unsplash public API).
 * Swap for studio-branded CDN assets in production.
 */

const U = (id: string, w = 800) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=80`;

export const FitnessImages = {
  strength:    U('1534438327276-14e5300c3a48'),   // dramatic weight room
  running:     U('1476480862126-209bfaa8edc8'),   // runner silhouette
  yoga:        U('1544367567-0f2fcb009e0b'),      // yoga studio
  hiit:        U('1549060279-7e168fcee0c2'),      // high-intensity workout
  cycling:     U('1471506480208-91b3a4cc78be'),   // indoor cycling
  boxing:      U('1571019613454-1cb2f99b2d8b'),   // boxing training
  pilates:     U('1518611012118-696072aa579a'),   // pilates class
  recovery:    U('1600618528240-fb9fc964b853'),   // recovery / restore
  mobility:    U('1506629082955-511b1aa562c8'),   // dynamic stretching
  performance: U('1526401485004-46910ecc8e51'),   // elite athlete
  gym:         U('1554284126-aa88f22d8b74'),      // premium gym space
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

/** Returns a consistent curated image URI based on the class name. */
export function resolveClassImageUri(className: string): string {
  const lower = className.toLowerCase();
  for (const [cat, kws] of KEYWORD_MAP) {
    if (kws.some((kw) => lower.includes(kw))) {
      return FitnessImages[cat];
    }
  }
  return FitnessImages.performance;
}

const COACH_PORTRAITS = [
  U('1517836357463-d25dfeac3438', 400),
  U('1573496359142-b8d87734a5a2', 400),
  U('1607962837359-5e7e89f86776', 400),
  U('1580489944761-15a19d654956', 400),
  U('1438761681033-6461ffad8d80', 400),
];

/** Stable portrait URI derived from the coach's name. */
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
