import { addDaysToDateKey, getStudioLocalDateKey, studioLocalDateKeyToUtcAnchor } from '../common/date/studio-local-date';

/**
 * Day Pass calendar-date rules. Pure; the studio's IANA timezone is the only clock.
 *
 * A Day Pass is bought for ONE studio-local calendar day, chosen by the member. The wire and
 * business representation is a canonical 'YYYY-MM-DD' key in the studio timezone; the DB keeps
 * the UTC instant of that day's local midnight (studioLocalDateKeyToUtcAnchor), which makes the
 * (studio, member, day) slot unique regardless of the device that made the request.
 */

/** Furthest day a member may buy for, counted in studio-local calendar days from today. */
export const DAY_PASS_PURCHASE_HORIZON_DAYS = 30;

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type DayPassDateWindow = {
  timezone: string;
  /** Studio-local today. */
  todayKey: string;
  /** Last purchasable day (inclusive). */
  maxDateKey: string;
  horizonDays: number;
};

export function dayPassDateWindow(timezone: string, now: Date = new Date()): DayPassDateWindow {
  const todayKey = getStudioLocalDateKey(now, timezone);
  return {
    timezone,
    todayKey,
    maxDateKey: addDaysToDateKey(todayKey, DAY_PASS_PURCHASE_HORIZON_DAYS),
    horizonDays: DAY_PASS_PURCHASE_HORIZON_DAYS,
  };
}

export type RequestedDateResolution =
  | { ok: true; key: string; anchorUtc: Date; window: DayPassDateWindow }
  | { ok: false; reason: 'invalid' | 'past' | 'beyond_horizon'; window: DayPassDateWindow };

/**
 * Resolves the member's requested day. The request is a WISH, never authority:
 *  - omitted (legacy clients)      → studio-local today
 *  - not canonical 'YYYY-MM-DD'    → invalid (e.g. '2026-13-01' or '2026-2-3')
 *  - before studio-local today     → past
 *  - after today + horizon         → beyond_horizon
 * Canonical means the key round-trips through the studio timezone unchanged, so a device in
 * any timezone can only ever name a real studio-local day.
 */
export function resolveRequestedDayPassDate(
  requested: string | null | undefined,
  timezone: string,
  now: Date = new Date(),
): RequestedDateResolution {
  const window = dayPassDateWindow(timezone, now);
  const key = (requested ?? '').trim() || window.todayKey;
  if (!DATE_KEY_RE.test(key)) {
    return { ok: false, reason: 'invalid', window };
  }
  const anchorUtc = studioLocalDateKeyToUtcAnchor(key, timezone);
  if (Number.isNaN(anchorUtc.getTime()) || getStudioLocalDateKey(anchorUtc, timezone) !== key) {
    return { ok: false, reason: 'invalid', window };
  }
  if (key < window.todayKey) {
    return { ok: false, reason: 'past', window };
  }
  if (key > window.maxDateKey) {
    return { ok: false, reason: 'beyond_horizon', window };
  }
  return { ok: true, key, anchorUtc, window };
}

export type DayPassRelativeDay = 'today' | 'upcoming' | 'past';

/** Where a pass's day sits relative to studio-local today. Lexical compare is safe on canonical keys. */
export function classifyDayPassDate(dateKey: string, todayKey: string): DayPassRelativeDay {
  if (dateKey === todayKey) return 'today';
  return dateKey > todayKey ? 'upcoming' : 'past';
}
