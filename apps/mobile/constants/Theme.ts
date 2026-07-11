/** Single product accent — deep indigo. */
export const Accent = '#5B5CEB';

export const dark = {
  bg:         '#000000',
  surface1:   '#0D0D0D',
  surface2:   '#161616',
  surface3:   '#1F1F1F',
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
  button: 10,
  pill:   100,
  inner:  8,
} as const;

export const Space = {
  screenH:    24,
  cardV:      20,
  cardH:      20,
  sectionGap: 40,
  cardGap:    12,
  row:        72,
  /** 8-point grid tokens */
  sp1: 8,
  sp2: 16,
  sp3: 24,
  sp4: 32,
  sp5: 40,
  sp6: 48,
} as const;
