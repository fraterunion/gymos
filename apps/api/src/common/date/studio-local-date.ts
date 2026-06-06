/**
 * Studio-local date utilities for multi-tenant timezone handling.
 *
 * Convention for DayPass.validForDate:
 *   validForDate stores the UTC instant that corresponds to local midnight (00:00:00)
 *   in the studio's IANA timezone on the given calendar date.
 *
 *   Example — America/Mexico_City (UTC-6, permanent since 2023 DST abolition):
 *     "June 8, 2026" → 2026-06-08T06:00:00Z  (midnight local = 06:00 UTC)
 *
 *   Example — America/New_York (UTC-4 in summer EDT):
 *     "June 8, 2026" → 2026-06-08T04:00:00Z  (midnight local = 04:00 UTC)
 *
 * Never hardcode a timezone offset. Always use studio.timezone (IANA string).
 */

/**
 * Returns the timezone offset in milliseconds for a given UTC instant in the
 * specified IANA timezone.
 *
 * offset = (local time read as if UTC) - (actual UTC time)
 * For UTC-6: offset = -6 hours  (local is 6 h behind UTC)
 * For UTC+5: offset = +5 hours  (local is 5 h ahead of UTC)
 *
 * Uses UTC midnight of the target date as the reference point so that the
 * offset reflects the timezone's state at the start of the local day — the
 * correct reference for computing when local midnight falls in UTC.
 */
function getTimezoneOffsetMs(utcInstant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23', // 0–23, avoids ambiguous '24' for midnight in some locales
  }).formatToParts(utcInstant);

  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');

  // Treat the local date+time components as if they were UTC to get a comparable ms value
  const localAsUtcMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );

  return localAsUtcMs - utcInstant.getTime();
}

/**
 * Returns the studio-local calendar date for any UTC instant as a 'YYYY-MM-DD' string.
 *
 * This is the authoritative way to determine which calendar date a given moment
 * belongs to from the studio's perspective — independent of the host machine's locale.
 *
 * @param date     - UTC instant (e.g. a class startsAt)
 * @param timezone - IANA timezone string from studio.timezone (e.g. 'America/Mexico_City')
 */
export function getStudioLocalDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Converts a studio-local 'YYYY-MM-DD' date key back to the UTC Date anchor
 * used as DayPass.validForDate.
 *
 * The anchor is the UTC instant that corresponds to local midnight (00:00:00)
 * in the given timezone on that calendar date.
 *
 * Round-trip guarantee:
 *   getStudioLocalDateKey(studioLocalDateKeyToUtcAnchor(key, tz), tz) === key
 *
 * @param dateKey  - 'YYYY-MM-DD' string in the studio's local calendar
 * @param timezone - IANA timezone string from studio.timezone
 */
export function studioLocalDateKeyToUtcAnchor(dateKey: string, timezone: string): Date {
  const [yearStr, monthStr, dayStr] = dateKey.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  // Use UTC midnight of this calendar date as the reference.
  // The offset at UTC midnight reflects the timezone's state at the start of
  // the local day — which is what we need to find when local midnight is in UTC.
  // (DST transitions happen at 2 am or later, never at UTC midnight.)
  const utcMidnight = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offsetMs = getTimezoneOffsetMs(utcMidnight, timezone);

  // anchor = utcMidnight - offset
  // UTC-6 example: offset = -6 h → anchor = utcMidnight + 6 h = 06:00 UTC ✓
  // UTC+5 example: offset = +5 h → anchor = utcMidnight - 5 h = prev day 19:00 UTC ✓
  return new Date(utcMidnight.getTime() - offsetMs);
}
