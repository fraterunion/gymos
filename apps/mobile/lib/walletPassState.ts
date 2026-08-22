// This module is intentionally self-contained (no imports from the rest of the app) so it
// stays runnable directly under `node --test` without Metro's path-alias resolution, and so
// it never accidentally becomes coupled to more than the one thing it actually needs: the
// shape of an ApiError (message/status/body), not the concrete class.
type ApiErrorShape = { message: string; status: number; body?: unknown };

function isApiErrorShape(e: unknown): e is ApiErrorShape {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { message?: unknown }).message === 'string' &&
    typeof (e as { status?: unknown }).status === 'number'
  );
}

export type MiPaseState =
  | { kind: 'loading' }
  | { kind: 'ready'; barcode: string }
  | { kind: 'not_eligible' }
  | { kind: 'reissue_required' }
  | { kind: 'network_error'; message: string };

/**
 * Pure state derivation — no rendering, no navigation, fully unit-testable. `cachedBarcode`
 * comes from walletCredentialStore (SecureStore), never re-fetched once known; `fetchError`
 * is only consulted when there is no cached barcode yet. `barcodeUnavailable` covers the
 * backend's other non-error terminal outcome: the fetch succeeded but returned
 * `{barcode: null}` because a credential already exists and this device/session never
 * received its raw value (e.g. reopening on a fresh install with no local cache) — the
 * backend deliberately withholds it rather than silently reissuing, which is the same
 * "needs help at reception" outcome as an explicit reissue.
 */
export function deriveMiPaseState(input: {
  loading: boolean;
  cachedBarcode: string | null;
  fetchError: unknown;
  barcodeUnavailable?: boolean;
}): MiPaseState {
  if (input.cachedBarcode) {
    return { kind: 'ready', barcode: input.cachedBarcode };
  }
  if (input.loading) {
    return { kind: 'loading' };
  }
  if (input.fetchError) {
    return classifyMiPaseError(input.fetchError);
  }
  if (input.barcodeUnavailable) {
    return { kind: 'reissue_required' };
  }
  return { kind: 'loading' };
}

function classifyMiPaseError(error: unknown): MiPaseState {
  if (!isApiErrorShape(error)) {
    return { kind: 'network_error', message: 'No pudimos conectar con el servidor. Desliza para reintentar.' };
  }
  const m = error.message;
  if (m.includes('WALLET_MEMBER_NOT_ACTIVE')) {
    return { kind: 'not_eligible' };
  }
  if (m.includes('WALLET_PASS_REISSUE_REQUIRED') || m.includes('WALLET_CREDENTIAL_REVOKED')) {
    return { kind: 'reissue_required' };
  }
  if (error.status === 0 || error.status >= 500) {
    return { kind: 'network_error', message: 'El servicio no está disponible por el momento. Inténtalo de nuevo en un momento.' };
  }
  return { kind: 'network_error', message: 'No pudimos cargar tu pase. Desliza para reintentar.' };
}

export type WalletButtonState = 'ready' | 'not_configured' | 'loading' | 'error';

/**
 * Wallet CTA buttons must never show a scary raw backend error — WALLET_APPLE_NOT_CONFIGURED /
 * WALLET_GOOGLE_NOT_CONFIGURED is a normal, expected development-time state (no Apple/Google
 * account exists yet), not a failure the member did anything wrong to cause.
 */
export function classifyWalletButtonError(error: unknown): 'not_configured' | 'error' {
  if (isApiErrorShape(error)) {
    if (error.message.includes('WALLET_APPLE_NOT_CONFIGURED') || error.message.includes('WALLET_GOOGLE_NOT_CONFIGURED')) {
      return 'not_configured';
    }
  }
  return 'error';
}

export type WalletCandidate = {
  bookingId: string;
  scheduledClassId: string;
  className: string;
  startsAt: string;
};

export type WalletMultipleCandidates = {
  memberName: string;
  candidates: WalletCandidate[];
};

/**
 * Extracts the Front Desk disambiguation candidate list from a WALLET_MULTIPLE_ELIGIBLE_BOOKINGS
 * error response — returns null for every other error shape so the caller falls back to the
 * normal error screen instead of a broken/empty selection UI.
 */
export function parseMultipleCandidatesError(error: unknown): WalletMultipleCandidates | null {
  if (!isApiErrorShape(error)) return null;
  const body = error.body as { code?: string; memberName?: unknown; candidates?: unknown } | undefined;
  if (body?.code !== 'WALLET_MULTIPLE_ELIGIBLE_BOOKINGS' || !Array.isArray(body.candidates)) {
    return null;
  }
  const candidates = body.candidates.filter(
    (c): c is WalletCandidate =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as WalletCandidate).bookingId === 'string' &&
      typeof (c as WalletCandidate).scheduledClassId === 'string' &&
      typeof (c as WalletCandidate).className === 'string' &&
      typeof (c as WalletCandidate).startsAt === 'string',
  );
  if (candidates.length === 0) return null;
  return { memberName: typeof body.memberName === 'string' ? body.memberName : 'Miembro', candidates };
}

/** A class the scanned member could be walked into — never a reservation. */
export type WalletWalkInCandidate = {
  scheduledClassId: string;
  className: string;
  startsAt: string;
};

export type WalletNoBooking = {
  memberId: string;
  memberName: string;
  walkInCandidates: WalletWalkInCandidate[];
};

function parseWalkInCandidates(value: unknown): WalletWalkInCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (c): c is WalletWalkInCandidate =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as WalletWalkInCandidate).scheduledClassId === 'string' &&
      typeof (c as WalletWalkInCandidate).className === 'string' &&
      typeof (c as WalletWalkInCandidate).startsAt === 'string',
  );
}

/**
 * Extracts the identified member (and any walk-in options) from a WALLET_NO_ELIGIBLE_BOOKING
 * response. The scan still failed to check anyone in — this only lets Front Desk see WHO was
 * scanned and offer the separate walk-in action instead of a dead end. Returns null when the
 * backend is older than Member Experience 1.3 and sent a bare message, so the caller falls
 * back to plain error copy.
 */
export function parseNoEligibleBookingError(error: unknown): WalletNoBooking | null {
  if (!isApiErrorShape(error)) return null;
  const body = error.body as
    | { code?: string; memberId?: unknown; memberName?: unknown; walkInCandidates?: unknown }
    | undefined;
  if (body?.code !== 'WALLET_NO_ELIGIBLE_BOOKING' || typeof body.memberId !== 'string') {
    return null;
  }
  return {
    memberId: body.memberId,
    memberName: typeof body.memberName === 'string' ? body.memberName : 'Miembro',
    walkInCandidates: parseWalkInCandidates(body.walkInCandidates),
  };
}

export type WalletAlreadyCheckedIn = {
  memberName: string;
  attendedClass: WalletWalkInCandidate | null;
};

/** Extracts who/what for WALLET_ALREADY_CHECKED_IN so staff see the class, not just a refusal. */
export function parseAlreadyCheckedInError(error: unknown): WalletAlreadyCheckedIn | null {
  if (!isApiErrorShape(error)) return null;
  const body = error.body as { code?: string; memberName?: unknown; attendedClass?: unknown } | undefined;
  if (body?.code !== 'WALLET_ALREADY_CHECKED_IN') return null;
  const [attendedClass] = parseWalkInCandidates(
    body.attendedClass ? [body.attendedClass] : [],
  );
  return {
    memberName: typeof body.memberName === 'string' ? body.memberName : 'Miembro',
    attendedClass: attendedClass ?? null,
  };
}

/** Front Desk copy for the Wallet-specific denial codes — mirrors staffScanErrorCopy's
 *  pattern for the existing booking-QR scanner, extended for Wallet credential scans. */
export function walletScanErrorCopy(error: unknown): { title: string; message: string } | null {
  if (!isApiErrorShape(error)) return null;
  const m = error.message;

  if (m.includes('WALLET_CREDENTIAL_REVOKED') || m.includes('WALLET_CREDENTIAL_INVALID')) {
    return {
      title: 'Pase no reconocido',
      message: 'Este pase ya no es válido. Pide al miembro que abra Mi Pase para generar uno nuevo.',
    };
  }
  if (m.includes('WALLET_WRONG_STUDIO')) {
    return { title: 'Pase de otro estudio', message: 'Este pase pertenece a otro estudio.' };
  }
  if (m.includes('WALLET_MEMBER_NOT_ACTIVE')) {
    return { title: 'Miembro inactivo', message: 'Este miembro ya no pertenece a este estudio.' };
  }
  if (m.includes('WALLET_NO_ELIGIBLE_BOOKING')) {
    return {
      title: 'Sin reserva activa',
      message: 'No encontramos una reserva disponible en este momento. Pide al miembro que reserve su clase.',
    };
  }
  if (m.includes('WALLET_ALREADY_CHECKED_IN')) {
    return { title: 'Ya registrado', message: 'Este miembro ya hizo check-in para esta clase.' };
  }
  return null;
}
