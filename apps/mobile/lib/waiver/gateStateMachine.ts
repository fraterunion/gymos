/**
 * Pure state machine computation for WaiverGate.
 *
 * Extracted from the component so it can be tested without React Native.
 * The component owns LOADING and SUBMITTING as transient phases;
 * this function only computes the stable phase from server responses.
 */
import type { PublicWaiverDto, WaiverStatusDto } from '@/lib/api/waiverApi';

export type GatePhase =
  | { tag: 'LOADING' }
  | { tag: 'PASSED' }
  | { tag: 'WAIVER_REQUIRED'; waiver: PublicWaiverDto }
  | { tag: 'SUBMITTING'; waiver: PublicWaiverDto }
  | { tag: 'RECOVERABLE_ERROR'; message: string };

/**
 * Given server responses from the parallel status + document requests,
 * returns the correct stable phase.
 *
 * Invariant: WAIVER_REQUIRED is ONLY returned when waiver is non-null.
 * If the API responds with required=true + accepted=false but no document,
 * that is classified as RECOVERABLE_ERROR (transient inconsistency).
 */
export function computeLoadedPhase(
  status: WaiverStatusDto,
  publicWaiver: PublicWaiverDto | null,
): Exclude<GatePhase, { tag: 'LOADING' } | { tag: 'SUBMITTING' }> {
  if (!status.required || status.accepted) {
    return { tag: 'PASSED' };
  }
  if (publicWaiver !== null) {
    return { tag: 'WAIVER_REQUIRED', waiver: publicWaiver };
  }
  // required && !accepted && waiver === null: invariant violation.
  // The API returned conflicting signals (status says required, public endpoint says
  // no active document). This is a transient state — treat as a recoverable error
  // so the user can retry rather than being permanently blocked.
  return {
    tag: 'RECOVERABLE_ERROR',
    message: 'No pudimos cargar la Carta Responsiva. Inténtalo de nuevo.',
  };
}
