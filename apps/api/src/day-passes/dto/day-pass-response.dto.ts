import type { DayPassStatus } from '@prisma/client';
import type { DayPassRelativeDay } from '../day-pass-dates';

export type DayPassResponseDto = {
  id: string;
  /** UTC instant of studio-local midnight on the pass's day (legacy field; kept for older clients). */
  validForDate: Date;
  /** The pass's day as a canonical studio-local 'YYYY-MM-DD' key — display this, never re-derive it on device. */
  validForDateKey: string;
  /** Where that day sits relative to studio-local today at response time. */
  relativeDay: DayPassRelativeDay;
  status: DayPassStatus;
  priceCents: number;
  currency: string;
  createdAt: Date;
};

/** Everything a client needs to let the member pick a day, computed on the studio clock. */
export type DayPassPurchaseWindowDto = {
  timezone: string;
  todayKey: string;
  maxDateKey: string;
  horizonDays: number;
  /** Days inside the window the member already owns (ACTIVE) — the picker must not sell them again. */
  ownedDateKeys: string[];
};
