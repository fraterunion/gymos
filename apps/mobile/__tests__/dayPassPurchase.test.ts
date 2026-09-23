import {
  DAY_PASS_COPY,
  canStartDayPassPurchase,
  describePostPaymentStatus,
  isAlreadyOwnedConflict,
  resolvePaymentSheetOutcome,
} from '@/lib/dayPassPurchase';

describe('PaymentSheet outcome mapping', () => {
  it('no error means the card step completed (not that the pass is owned)', () => {
    expect(resolvePaymentSheetOutcome(undefined)).toEqual({ kind: 'completed' });
    expect(resolvePaymentSheetOutcome(null)).toEqual({ kind: 'completed' });
  });

  it('a deliberate dismissal is silent and keeps the attempt reusable', () => {
    expect(resolvePaymentSheetOutcome({ code: 'Canceled', message: 'The payment has been canceled' })).toEqual({
      kind: 'canceled',
    });
  });

  it('a decline is shown in Spanish, never as Stripe\'s raw English message', () => {
    const out = resolvePaymentSheetOutcome({ code: 'Failed', message: 'Your card was declined.' });
    expect(out).toEqual({ kind: 'failed', message: DAY_PASS_COPY.cardFailed });
    expect(out.kind === 'failed' && out.message).not.toMatch(/declined/i);
  });

  it('a timeout gets its own connectivity copy', () => {
    expect(resolvePaymentSheetOutcome({ code: 'Timeout' })).toEqual({ kind: 'failed', message: DAY_PASS_COPY.timeout });
  });

  it('an unknown code is treated as a failure, not as success', () => {
    expect(resolvePaymentSheetOutcome({ code: 'SomethingNew' }).kind).toBe('failed');
  });
});

describe('post-payment status (server truth)', () => {
  it('only ACTIVE from the server counts as an activated pass', () => {
    expect(describePostPaymentStatus('ACTIVE')).toEqual({ kind: 'activated', message: DAY_PASS_COPY.activated });
  });

  it('PENDING / unknown after the card step means "confirming", never "failed"', () => {
    for (const s of ['PENDING', 'EXPIRED', null, undefined] as const) {
      const a = describePostPaymentStatus(s);
      expect(a.kind).toBe('confirming');
      expect(a.message).toBe(DAY_PASS_COPY.confirming);
    }
  });
});

describe('double-tap guard', () => {
  it('allows a purchase only when neither state nor the in-flight ref says busy', () => {
    expect(canStartDayPassPurchase(false, false)).toBe(true);
    expect(canStartDayPassPurchase(true, false)).toBe(false);
    expect(canStartDayPassPurchase(false, true)).toBe(false);
  });
});

describe('copy hygiene', () => {
  it('every member-facing line is Spanish and free of technical noise', () => {
    for (const line of Object.values(DAY_PASS_COPY)) {
      expect(line).toMatch(/[áéíóúñ]|Pase |Pago |No |La /);
      expect(line).not.toMatch(/Stripe|PaymentIntent|error code|undefined/i);
      expect(line.length).toBeLessThan(160);
    }
  });
});

describe('already-owned conflict', () => {
  it('recognises the server 409 for an owned pass (shown neutrally, list reloaded)', () => {
    expect(isAlreadyOwnedConflict({ status: 409, message: 'Ya tienes un pase diario activo para esta fecha.' })).toBe(true);
  });

  it('does not treat other conflicts or statuses as ownership', () => {
    expect(isAlreadyOwnedConflict({ status: 409, message: 'Ya hay un intento de compra en curso para esta fecha.' })).toBe(false);
    expect(isAlreadyOwnedConflict({ status: 400, message: 'Ya tienes un pase diario activo para esta fecha.' })).toBe(false);
    expect(isAlreadyOwnedConflict(null)).toBe(false);
    expect(isAlreadyOwnedConflict(new Error('boom'))).toBe(false);
  });
});
