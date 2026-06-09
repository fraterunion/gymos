import {
  getStudioLocalDateKey,
  studioLocalDateKeyToUtcAnchor,
} from '../common/date/studio-local-date';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type StudioMonthBounds = {
  start: Date;
  end: Date;
  year: number;
  month: number;
};

export function getCurrentStudioMonthBounds(
  timezone: string,
  now: Date = new Date(),
): StudioMonthBounds {
  const nowKey = getStudioLocalDateKey(now, timezone);
  const [year, month] = nowKey.split('-').map(Number);
  const monthStartKey = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const nextMonthYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextMonthStartKey = `${nextMonthYear}-${String(nextMonth).padStart(2, '0')}-01`;

  return {
    start: studioLocalDateKeyToUtcAnchor(monthStartKey, timezone),
    end: studioLocalDateKeyToUtcAnchor(nextMonthStartKey, timezone),
    year,
    month,
  };
}

/** ISO week key (YYYY-Www) for a class instant in the studio timezone. */
export function getIsoWeekKey(utcInstant: Date, timezone: string): string {
  const dateKey = getStudioLocalDateKey(utcInstant, timezone);
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function parseIsoWeekKey(key: string): { year: number; week: number } {
  const match = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!match) {
    throw new Error(`Invalid ISO week key: ${key}`);
  }
  return { year: Number(match[1]), week: Number(match[2]) };
}

/** Monday 00:00 UTC of the ISO week (for consecutive-week comparisons). */
export function isoWeekToMondayUtc(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

export function weekKeyToMondayMs(key: string): number {
  const { year, week } = parseIsoWeekKey(key);
  return isoWeekToMondayUtc(year, week).getTime();
}

export function previousIsoWeekKey(key: string): string {
  const monday = new Date(weekKeyToMondayMs(key) - ONE_WEEK_MS);
  const year = monday.getUTCFullYear();
  const month = monday.getUTCMonth() + 1;
  const day = monday.getUTCDate();
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function computeIsoWeekStreaks(
  weekKeys: Set<string>,
  currentWeekKey: string,
): { currentStreak: number; bestStreak: number } {
  if (weekKeys.size === 0) {
    return { currentStreak: 0, bestStreak: 0 };
  }

  const sorted = [...weekKeys].sort(
    (a, b) => weekKeyToMondayMs(a) - weekKeyToMondayMs(b),
  );

  let bestStreak = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const delta = weekKeyToMondayMs(sorted[i]) - weekKeyToMondayMs(sorted[i - 1]);
    if (delta === ONE_WEEK_MS) {
      run++;
    } else {
      run = 1;
    }
    bestStreak = Math.max(bestStreak, run);
  }

  const currentMonday = weekKeyToMondayMs(currentWeekKey);
  const anchorCandidates = sorted.filter(
    (key) => weekKeyToMondayMs(key) <= currentMonday,
  );
  if (anchorCandidates.length === 0) {
    return { currentStreak: 0, bestStreak };
  }

  let anchor = anchorCandidates[anchorCandidates.length - 1];
  let currentStreak = 0;
  while (weekKeys.has(anchor)) {
    currentStreak++;
    anchor = previousIsoWeekKey(anchor);
  }

  return { currentStreak, bestStreak };
}
