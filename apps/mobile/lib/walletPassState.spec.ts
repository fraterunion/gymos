import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyWalletButtonError,
  deriveMiPaseState,
  parseMultipleCandidatesError,
  walletScanErrorCopy,
} from './walletPassState.ts';

// walletPassState.ts duck-types on {message, status, body?} rather than importing the real
// ApiError class (see its own comment) — this local double mirrors that shape without pulling
// in api/errors.ts, whose parameter-property constructor syntax Node's strip-only mode can't
// parse. It stands in for both ApiError and TimeoutError in these tests.
class FakeApiError extends Error {
  status: number;
  body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
const ApiError = FakeApiError;

test('a cached barcode always wins — never re-fetches once known', () => {
  const state = deriveMiPaseState({ loading: true, cachedBarcode: 'gymos:v1:abc', fetchError: null });
  assert.deepEqual(state, { kind: 'ready', barcode: 'gymos:v1:abc' });
});

test('a successful fetch that returns no barcode (credential exists, raw already spent, no local cache) resolves to reissue_required, not an infinite loading state', () => {
  const state = deriveMiPaseState({
    loading: false,
    cachedBarcode: null,
    fetchError: null,
    barcodeUnavailable: true,
  });
  assert.deepEqual(state, { kind: 'reissue_required' });
});

test('loading with no cache and no error yet stays in loading', () => {
  const state = deriveMiPaseState({ loading: true, cachedBarcode: null, fetchError: null });
  assert.deepEqual(state, { kind: 'loading' });
});

test('WALLET_MEMBER_NOT_ACTIVE maps to not_eligible, not a generic error', () => {
  const error = new ApiError('WALLET_MEMBER_NOT_ACTIVE', 403);
  const state = deriveMiPaseState({ loading: false, cachedBarcode: null, fetchError: error });
  assert.deepEqual(state, { kind: 'not_eligible' });
});

test('WALLET_PASS_REISSUE_REQUIRED and WALLET_CREDENTIAL_REVOKED both map to reissue_required', () => {
  const a = deriveMiPaseState({
    loading: false,
    cachedBarcode: null,
    fetchError: new ApiError('WALLET_PASS_REISSUE_REQUIRED', 409),
  });
  const b = deriveMiPaseState({
    loading: false,
    cachedBarcode: null,
    fetchError: new ApiError('WALLET_CREDENTIAL_REVOKED', 401),
  });
  assert.equal(a.kind, 'reissue_required');
  assert.equal(b.kind, 'reissue_required');
});

test('reissue_required never leaks the raw backend code into user-facing state', () => {
  const state = deriveMiPaseState({
    loading: false,
    cachedBarcode: null,
    fetchError: new ApiError('WALLET_PASS_REISSUE_REQUIRED', 409),
  });
  assert.equal(JSON.stringify(state).includes('WALLET_PASS_REISSUE_REQUIRED'), false);
});

test('a network-level failure (non-ApiError) maps to network_error with friendly copy', () => {
  const state = deriveMiPaseState({ loading: false, cachedBarcode: null, fetchError: new Error('fetch failed') });
  assert.equal(state.kind, 'network_error');
  if (state.kind === 'network_error') {
    assert.doesNotMatch(state.message, /WALLET_|error|Error/);
  }
});

test('a 5xx response maps to network_error', () => {
  const state = deriveMiPaseState({
    loading: false,
    cachedBarcode: null,
    fetchError: new ApiError('Internal Server Error', 500),
  });
  assert.equal(state.kind, 'network_error');
});

test('classifyWalletButtonError treats WALLET_APPLE_NOT_CONFIGURED as a dev-safe state, not an error', () => {
  const kind = classifyWalletButtonError(new ApiError('WALLET_APPLE_NOT_CONFIGURED', 409));
  assert.equal(kind, 'not_configured');
});

test('classifyWalletButtonError treats WALLET_GOOGLE_NOT_CONFIGURED as a dev-safe state', () => {
  const kind = classifyWalletButtonError(new ApiError('WALLET_GOOGLE_NOT_CONFIGURED', 409));
  assert.equal(kind, 'not_configured');
});

test('classifyWalletButtonError treats every other failure as a real error', () => {
  assert.equal(classifyWalletButtonError(new ApiError('WALLET_PASS_REISSUE_REQUIRED', 409)), 'error');
  assert.equal(classifyWalletButtonError(new Error('network down')), 'error');
});

test('parseMultipleCandidatesError extracts memberName + candidates from the exact backend shape', () => {
  const body = {
    code: 'WALLET_MULTIPLE_ELIGIBLE_BOOKINGS',
    memberName: 'Rodrigo Ponce',
    candidates: [
      { bookingId: 'b1', scheduledClassId: 'c1', className: 'Upperbody', startsAt: '2026-08-22T07:00:00.000Z' },
      { bookingId: 'b2', scheduledClassId: 'c2', className: 'Street Bars', startsAt: '2026-08-22T08:00:00.000Z' },
    ],
  };
  const result = parseMultipleCandidatesError(new ApiError('WALLET_MULTIPLE_ELIGIBLE_BOOKINGS', 409, body));
  assert.deepEqual(result, { memberName: 'Rodrigo Ponce', candidates: body.candidates });
});

test('parseMultipleCandidatesError returns null for every other error shape', () => {
  assert.equal(parseMultipleCandidatesError(new ApiError('WALLET_NO_ELIGIBLE_BOOKING', 409)), null);
  assert.equal(parseMultipleCandidatesError(new Error('not an ApiError')), null);
  assert.equal(
    parseMultipleCandidatesError(new ApiError('WALLET_MULTIPLE_ELIGIBLE_BOOKINGS', 409, { code: 'WALLET_MULTIPLE_ELIGIBLE_BOOKINGS' })),
    null,
  );
});

test('parseMultipleCandidatesError falls back to "Miembro" if memberName is somehow missing', () => {
  const body = {
    code: 'WALLET_MULTIPLE_ELIGIBLE_BOOKINGS',
    candidates: [{ bookingId: 'b1', scheduledClassId: 'c1', className: 'Upperbody', startsAt: '2026-08-22T07:00:00.000Z' }],
  };
  const result = parseMultipleCandidatesError(new ApiError('x', 409, body));
  assert.equal(result?.memberName, 'Miembro');
});

test('walletScanErrorCopy gives distinct, friendly Spanish copy for every Wallet denial code', () => {
  const cases: Array<[string, string]> = [
    ['WALLET_CREDENTIAL_REVOKED', 'Pase no reconocido'],
    ['WALLET_CREDENTIAL_INVALID', 'Pase no reconocido'],
    ['WALLET_WRONG_STUDIO', 'Pase de otro estudio'],
    ['WALLET_MEMBER_NOT_ACTIVE', 'Miembro inactivo'],
    ['WALLET_NO_ELIGIBLE_BOOKING', 'Sin reserva activa'],
    ['WALLET_ALREADY_CHECKED_IN', 'Ya registrado'],
  ];
  for (const [code, expectedTitle] of cases) {
    const copy = walletScanErrorCopy(new ApiError(code, 409));
    assert.equal(copy?.title, expectedTitle, `code ${code}`);
    // Never leak the raw machine code into what Front Desk sees.
    assert.doesNotMatch(copy!.message, /WALLET_[A-Z_]+/);
  }
});

test('walletScanErrorCopy returns null for a non-Wallet error, letting the caller fall back', () => {
  assert.equal(walletScanErrorCopy(new ApiError('Already checked in', 409)), null);
  assert.equal(walletScanErrorCopy(new Error('boom')), null);
});
