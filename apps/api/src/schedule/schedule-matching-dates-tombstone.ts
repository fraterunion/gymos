/** Prefix stored on cancelReason so week copy and the generator can recognize these tombstones. */
export const MATCHING_DATES_TOMBSTONE_PREFIX = 'matching-future-dates:';

export function isMatchingDatesTombstone(cancelReason: string | null | undefined): boolean {
  return typeof cancelReason === 'string' && cancelReason.startsWith(MATCHING_DATES_TOMBSTONE_PREFIX);
}

export function matchingDatesCancelReason(staffReason: string | null): string {
  const text = staffReason?.trim();
  const value = text ? `${MATCHING_DATES_TOMBSTONE_PREFIX} ${text}` : MATCHING_DATES_TOMBSTONE_PREFIX;
  return value.slice(0, 500);
}
