/**
 * Cancellation safety policy, mirrored from the API: a class that already started or ended, or
 * that already has attendance (early check-in), cannot be cancelled — the API refuses it directly
 * and keeps it during series cancellations. The schedule UI does not offer "Cancelar clase" for it.
 *
 * Self-contained for `node --test`.
 */
export function classHasStarted(startsAtIso: string, now: number = Date.now()): boolean {
  return new Date(startsAtIso).getTime() <= now;
}

export function canOfferClassCancel(
  cls: { startsAt: string; status?: string; attendedCount?: number | null },
  now: number = Date.now(),
): boolean {
  if (cls.status === "COMPLETED" || cls.status === "CANCELLED") return false;
  if (classHasStarted(cls.startsAt, now)) return false;
  return !(cls.attendedCount && cls.attendedCount > 0);
}

/** Bulk “cancel every matching date” is offered only from a future unlinked SCHEDULED session. */
export function canOfferMatchingDatesCancel(
  cls: { startsAt: string; status?: string; attendedCount?: number | null; isRecurring: boolean },
  now: number = Date.now(),
): boolean {
  if (cls.isRecurring) return false;
  if (cls.status !== "SCHEDULED") return false;
  return canOfferClassCancel(cls, now);
}

/** Sentence appended to a series-cancellation confirmation or result; empty when nothing is kept. */
export function protectedClassesNote(count: number | null | undefined): string {
  if (!count) return "";
  return count === 1
    ? " 1 clase con asistencia registrada se conservará."
    : ` ${count} clases con asistencia registrada se conservarán.`;
}
