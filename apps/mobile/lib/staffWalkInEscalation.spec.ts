import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLASS_WALK_IN_CTA_LABEL,
  shouldOfferClassWalkInEscalation,
} from './staffWalkInEscalation.ts';
import { resolveStaffScanErrorCopy } from './staffScanErrorCopy.ts';
import {
  openGymDenialCopy,
  parseOpenGymDenialError,
  parseNoEligibleBookingError,
} from './walletPassState.ts';

class FakeApiError extends Error {
  status: number;
  body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const candidate = {
  scheduledClassId: 'cls_1',
  className: 'Legs + HIIT',
  startsAt: '2026-08-22T13:00:00.000Z',
};

// ── Walk-in CTA policy ─────────────────────────────────────────────────────────

test('WALLET_MEMBERSHIP_NOT_ENTITLED / not_entitled → CTA hidden even with candidates', () => {
  assert.equal(
    shouldOfferClassWalkInEscalation({
      outcome: 'denied',
      openGymDenialReason: 'not_entitled',
      canRegisterManualAttendance: true,
      walkInCandidateCount: 1,
    }),
    false,
  );
  assert.equal(CLASS_WALK_IN_CTA_LABEL, 'Registrar en una clase');
});

test('WALLET_OPEN_GYM_NOT_INCLUDED + candidates → offer class walk-in CTA', () => {
  assert.equal(
    shouldOfferClassWalkInEscalation({
      outcome: 'denied',
      openGymDenialReason: 'not_included',
      canRegisterManualAttendance: true,
      walkInCandidateCount: 1,
    }),
    true,
  );
});

test('WALLET_OPEN_GYM_OUTSIDE_HOURS + candidates → offer class walk-in CTA', () => {
  assert.equal(
    shouldOfferClassWalkInEscalation({
      outcome: 'denied',
      openGymDenialReason: 'outside_hours',
      canRegisterManualAttendance: true,
      walkInCandidateCount: 2,
    }),
    true,
  );
});

test('WALLET_NO_ELIGIBLE_BOOKING (no_booking) + candidates → offer class walk-in CTA', () => {
  assert.equal(
    shouldOfferClassWalkInEscalation({
      outcome: 'no_booking',
      openGymDenialReason: null,
      canRegisterManualAttendance: true,
      walkInCandidateCount: 1,
    }),
    true,
  );
});

test('no candidates → no CTA', () => {
  assert.equal(
    shouldOfferClassWalkInEscalation({
      outcome: 'denied',
      openGymDenialReason: 'not_included',
      canRegisterManualAttendance: true,
      walkInCandidateCount: 0,
    }),
    false,
  );
});

test('unauthorized staff role → no CTA', () => {
  assert.equal(
    shouldOfferClassWalkInEscalation({
      outcome: 'denied',
      openGymDenialReason: 'not_included',
      canRegisterManualAttendance: false,
      walkInCandidateCount: 1,
    }),
    false,
  );
});

test('successful Open Gym / booked class outcomes never offer walk-in CTA', () => {
  assert.equal(
    shouldOfferClassWalkInEscalation({
      outcome: 'open_gym',
      canRegisterManualAttendance: true,
      walkInCandidateCount: 1,
    }),
    false,
  );
  assert.equal(
    shouldOfferClassWalkInEscalation({
      outcome: 'success',
      canRegisterManualAttendance: true,
      walkInCandidateCount: 1,
    }),
    false,
  );
});

test('CTA label is class-explicit, not a facility override', () => {
  assert.equal(CLASS_WALK_IN_CTA_LABEL, 'Registrar en una clase');
  assert.equal(CLASS_WALK_IN_CTA_LABEL.includes('sin reserva'), false);
});

// ── Denial parsers still surface candidates (UI decides whether to show CTA) ───

test('parseOpenGymDenialError keeps candidates for not_entitled (screen hides CTA)', () => {
  const error = new FakeApiError('WALLET_MEMBERSHIP_NOT_ENTITLED', 409, {
    code: 'WALLET_MEMBERSHIP_NOT_ENTITLED',
    memberId: 'user_1',
    memberName: 'Diego Ponce',
    walkInCandidates: [candidate],
  });
  const parsed = parseOpenGymDenialError(error);
  assert.equal(parsed?.reason, 'not_entitled');
  assert.equal(parsed?.walkInCandidates.length, 1);
  const copy = openGymDenialCopy(parsed!);
  assert.equal(copy.title, 'Membresía no vigente');
  assert.match(copy.message, /membresía activa/i);
});

test('parseNoEligibleBookingError still carries walk-in candidates', () => {
  const error = new FakeApiError('WALLET_NO_ELIGIBLE_BOOKING', 409, {
    code: 'WALLET_NO_ELIGIBLE_BOOKING',
    memberId: 'user_1',
    memberName: 'Alex',
    walkInCandidates: [candidate],
  });
  const parsed = parseNoEligibleBookingError(error);
  assert.equal(parsed?.walkInCandidates.length, 1);
});

// ── MEMBERSHIP_EXPIRED vs QR expiration copy ───────────────────────────────────

test('MEMBERSHIP_EXPIRED → membership-specific copy, not QR expiration', () => {
  const copy = resolveStaffScanErrorCopy('MEMBERSHIP_EXPIRED', 400);
  assert.equal(copy.title, 'Membresía no vigente');
  assert.match(copy.message, /membresía activa/i);
  assert.equal(copy.title.includes('QR'), false);
  assert.equal(copy.message.toLowerCase().includes('código qr'), false);
});

test('actual QR/token expiration still uses QR copy', () => {
  for (const msg of [
    'QR token expired',
    'Invalid or expired QR',
    'This QR code has already been used or expired',
    'invalid qr token',
  ]) {
    const copy = resolveStaffScanErrorCopy(msg, 400);
    assert.equal(copy.title, 'Código QR expirado o inválido', msg);
    assert.match(copy.message, /código QR/i, msg);
  }
});
