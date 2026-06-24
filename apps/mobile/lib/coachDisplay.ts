const DISPLAY_NAMES: Record<string, string> = {
  jorge: 'Jorge',
  fer: 'Fer',
  fernando: 'Fer',
  yayo: 'Yayo',
  jp: 'JP',
  'juan pablo': 'JP',
  karen: 'Karen',
  estefy: 'Estefy',
  mau: 'Mau',
};

/** First-name only for member-facing coach labels. */
export function resolveCoachDisplayName(firstName: string, _lastName?: string): string {
  const trimmed = firstName.trim();
  const mapped = DISPLAY_NAMES[trimmed.toLowerCase()];
  return mapped ?? trimmed;
}
