/**
 * ARES 1.3 — canonical weekly class schedule (America/Mexico_City local times).
 * Open Gym 10:00–17:00 is a membership benefit only — not represented here.
 */

export const ARES_SLUG = 'ares-fitness';
export const ARES_TZ = 'America/Mexico_City';
export const OPEN_GYM_HOURS_COPY = '10:00 a.m. – 5:00 p.m.';
export const OPEN_GYM_BENEFIT_PREFIX = `Open Gym · ${OPEN_GYM_HOURS_COPY}`;

export const ARES_MIGRATION_CANCEL_REASON = 'ARES 1.3 schedule migration';
export const ARES_GENERATE_THROUGH = '2026-12-31';

/** dayOfWeek: 0=Sun … 6=Sat (matches Prisma ScheduleTemplate) */
export type AresWeeklyDay = {
  dayOfWeek: number;
  label: string;
  classTemplateName: string;
  startTimes: string[];
};

export const ARES_WEEKLY_SCHEDULE: AresWeeklyDay[] = [
  {
    dayOfWeek: 1,
    label: 'Monday',
    classTemplateName: 'Legs + HIIT',
    startTimes: ['06:00', '07:00', '08:00', '09:00', '18:00', '19:00', '20:00'],
  },
  {
    dayOfWeek: 2,
    label: 'Tuesday',
    classTemplateName: 'Pull',
    startTimes: ['06:00', '07:00', '08:00', '09:00', '18:00', '19:00', '20:00'],
  },
  {
    dayOfWeek: 3,
    label: 'Wednesday',
    classTemplateName: 'Push',
    startTimes: ['06:00', '07:00', '08:00', '09:00', '18:00', '19:00', '20:00'],
  },
  {
    dayOfWeek: 4,
    label: 'Thursday',
    classTemplateName: 'Full Body + Core',
    startTimes: ['06:00', '07:00', '08:00', '09:00', '18:00', '19:00', '20:00'],
  },
  {
    dayOfWeek: 5,
    label: 'Friday',
    classTemplateName: 'Legs Strength',
    startTimes: ['06:00', '07:00', '08:00', '09:00', '18:00'],
  },
  {
    dayOfWeek: 6,
    label: 'Saturday',
    classTemplateName: 'Street Bars',
    startTimes: ['08:00'],
  },
  {
    dayOfWeek: 6,
    label: 'Saturday',
    classTemplateName: 'Upperbody',
    startTimes: ['09:00'],
  },
  {
    dayOfWeek: 0,
    label: 'Sunday',
    classTemplateName: 'Full Body',
    startTimes: ['09:00'],
  },
];

/** Templates kept for ad-hoc / history but excluded from weekly generator pattern. */
export const ARES_ADHOC_TEMPLATE_NAMES = ['Calirox', 'Hyrox'] as const;

export type TemplateRename = { from: string; to: string };

export const ARES_TEMPLATE_RENAMES: TemplateRename[] = [
  { from: 'Upper Pull', to: 'Pull' },
  { from: 'Upper Push', to: 'Push' },
  { from: 'Power Legs', to: 'Legs Strength' },
];

export type NewTemplateDef = {
  name: string;
  cloneFrom?: string;
  description: string;
  durationMinutes: number;
  color: string;
};

export const ARES_NEW_TEMPLATES: NewTemplateDef[] = [
  {
    name: 'Legs + HIIT',
    cloneFrom: 'Legs Strength',
    description:
      'Piernas e intervalos de alta intensidad. Fuerza de tren inferior combinada con bloques HIIT.',
    durationMinutes: 60,
    color: '#8b5cf6',
  },
  {
    name: 'Full Body + Core',
    cloneFrom: 'Full Body',
    description:
      'Trabajo completo de tren superior e inferior con énfasis en core y estabilidad.',
    durationMinutes: 60,
    color: '#ef4444',
  },
  {
    name: 'Upperbody',
    cloneFrom: 'Push',
    description: 'Rutina enfocada en tren superior. ARES Method.',
    durationMinutes: 60,
    color: '#c9a227',
  },
];

export function expectedClassesPerWeek(): Record<string, number> {
  const byDay: Record<string, number> = {
    Mon: 0,
    Tue: 0,
    Wed: 0,
    Thu: 0,
    Fri: 0,
    Sat: 0,
    Sun: 0,
  };
  const map: Record<number, keyof typeof byDay> = {
    0: 'Sun',
    1: 'Mon',
    2: 'Tue',
    3: 'Wed',
    4: 'Thu',
    5: 'Fri',
    6: 'Sat',
  };
  for (const row of ARES_WEEKLY_SCHEDULE) {
    byDay[map[row.dayOfWeek]!] += row.startTimes.length;
  }
  return byDay;
}

export function totalWeeklyTemplateSlots(): number {
  return ARES_WEEKLY_SCHEDULE.reduce((n, d) => n + d.startTimes.length, 0);
}
