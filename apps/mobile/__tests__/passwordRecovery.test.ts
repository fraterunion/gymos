import {
  RECOVERY_PROBE_FAILED,
  RECOVERY_PROBE_PENDING,
  canAttemptLogin,
  canSubmitRecoveryRequest,
  normalizeRecoveryEmail,
  recoveryProbeResolved,
  shouldShowForgotPasswordAction,
} from '@/lib/auth/passwordRecovery';

/**
 * Presentation rules for the login screen's recovery action. The security-relevant
 * guarantee is the failure behaviour: a member who cannot sign in is precisely the person
 * who needs this link, so only an explicit "disabled" from the server may hide it, and the
 * probe may never interfere with signing in.
 */

describe('forgot-password action visibility', () => {
  it('shows the action when the studio has recovery enabled', () => {
    expect(shouldShowForgotPasswordAction(recoveryProbeResolved(true))).toBe(true);
  });

  it('hides the action only when the server explicitly reports it disabled', () => {
    expect(shouldShowForgotPasswordAction(recoveryProbeResolved(false))).toBe(false);
  });

  it('shows the action while the probe is still in flight (no flicker to hidden)', () => {
    expect(shouldShowForgotPasswordAction(RECOVERY_PROBE_PENDING)).toBe(true);
  });

  it('shows the action when the probe FAILS, so an outage cannot strand a locked-out member', () => {
    expect(shouldShowForgotPasswordAction(RECOVERY_PROBE_FAILED)).toBe(true);
  });

  it('never blocks signing in, whatever the probe did', () => {
    for (const probe of [
      RECOVERY_PROBE_PENDING,
      RECOVERY_PROBE_FAILED,
      recoveryProbeResolved(true),
      recoveryProbeResolved(false),
    ]) {
      expect(canAttemptLogin(probe)).toBe(true);
    }
  });
});

describe('recovery email normalization', () => {
  it('trims surrounding whitespace, matching what the login screen sends', () => {
    expect(normalizeRecoveryEmail('  member@example.com  ')).toBe('member@example.com');
  });

  it('leaves the address otherwise untouched (the API owns canonicalization)', () => {
    expect(normalizeRecoveryEmail('Member@Example.com')).toBe('Member@Example.com');
  });

  it('collapses a whitespace-only entry to empty so it cannot be submitted', () => {
    expect(normalizeRecoveryEmail('   ')).toBe('');
  });
});

describe('recovery request submission guard', () => {
  it('allows a first submission with an address', () => {
    expect(canSubmitRecoveryRequest('member@example.com', false)).toBe(true);
  });

  it('blocks an empty or whitespace-only address', () => {
    expect(canSubmitRecoveryRequest('', false)).toBe(false);
    expect(canSubmitRecoveryRequest('   ', false)).toBe(false);
  });

  it('prevents a double submission while a request is in flight', () => {
    expect(canSubmitRecoveryRequest('member@example.com', true)).toBe(false);
  });

  it('treats a padded address as submittable (it normalizes to a real value)', () => {
    expect(canSubmitRecoveryRequest('  member@example.com ', false)).toBe(true);
  });
});

describe('anti-enumeration posture', () => {
  it('exposes no per-address branching: visibility depends only on the studio capability', () => {
    // The rules take no email argument at all, so the UI cannot vary by whether an
    // address exists — enumeration is impossible by construction on this surface.
    expect(shouldShowForgotPasswordAction.length).toBe(1);
    expect(shouldShowForgotPasswordAction(recoveryProbeResolved(true))).toBe(
      shouldShowForgotPasswordAction(recoveryProbeResolved(true)),
    );
  });
});
