export const dark = {
  bg:         '#0A0A0A',
  surface1:   '#141414',
  surface2:   '#1C1C1C',
  surface3:   '#282828',
  text:       '#FFFFFF',
  textSub:    'rgba(255,255,255,0.55)',
  textMute:   'rgba(255,255,255,0.32)',
  separator:  'rgba(255,255,255,0.07)',
  positive:   '#34D399',
  caution:    '#FBBF24',
  negative:   '#F87171',
} as const;

export const light = {
  bg:         '#F7F7F7',
  surface1:   '#EFEFEF',
  surface2:   '#FFFFFF',
  surface3:   '#F5F5F5',
  text:       '#0A0A0A',
  textSub:    'rgba(10,10,10,0.55)',
  textMute:   'rgba(10,10,10,0.35)',
  separator:  'rgba(0,0,0,0.06)',
  positive:   '#059669',
  caution:    '#D97706',
  negative:   '#DC2626',
} as const;

export type ThemeColors = {
  bg: string;
  surface1: string;
  surface2: string;
  surface3: string;
  text: string;
  textSub: string;
  textMute: string;
  separator: string;
  positive: string;
  caution: string;
  negative: string;
};

/**
 * Always returns dark colors — this is a dark-first premium app.
 * Light mode support intentionally disabled until a separate light theme is designed.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getColors(_scheme?: 'light' | 'dark' | null | undefined): ThemeColors {
  return dark;
}

export const Radius = {
  card:   16,
  button: 14,
  pill:   100,
  inner:  8,
} as const;

export const Space = {
  screenH:    24,
  cardV:      18,
  cardH:      20,
  sectionGap: 36,
  cardGap:    10,
} as const;
