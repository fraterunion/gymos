/**
 * A class that has already started is history: the API refuses to cancel it (in progress or past)
 * so its attendance and bookings stay; the schedule UI does not offer "Cancelar clase" for it.
 *
 * Self-contained for `node --test`.
 */
export function classHasStarted(startsAtIso: string, now: number = Date.now()): boolean {
  return new Date(startsAtIso).getTime() <= now;
}
