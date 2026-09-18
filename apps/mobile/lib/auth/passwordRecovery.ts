/**
 * Password-recovery presentation rules, kept pure so they can be tested without a
 * renderer (this app's jest setup runs logic tests only).
 *
 * Recovery is a platform capability a studio can switch off, so the login screen asks the
 * API whether to offer it. The rule that matters is what happens when that answer has not
 * arrived or never arrives: the action stays VISIBLE. A member who cannot sign in is
 * exactly the person who needs it, and hiding the way back because a probe timed out would
 * strand them. The only state that hides it is an explicit "no" from the server.
 *
 * Nothing here is studio-specific: the capability is resolved per deployment from the API.
 */

export type RecoveryProbeState =
  /** Probe in flight, or not started. */
  | { status: 'pending' }
  /** Server answered. */
  | { status: 'resolved'; passwordRecoveryEnabled: boolean }
  /** Probe failed (offline, timeout, API unreachable). */
  | { status: 'failed' };

export const RECOVERY_PROBE_PENDING: RecoveryProbeState = { status: 'pending' };

export function recoveryProbeResolved(passwordRecoveryEnabled: boolean): RecoveryProbeState {
  return { status: 'resolved', passwordRecoveryEnabled };
}

export const RECOVERY_PROBE_FAILED: RecoveryProbeState = { status: 'failed' };

/**
 * Whether the login screen offers "¿Olvidaste tu contraseña?".
 * Hidden only when the server explicitly reports the capability as disabled.
 */
export function shouldShowForgotPasswordAction(probe: RecoveryProbeState): boolean {
  return probe.status === 'resolved' ? probe.passwordRecoveryEnabled : true;
}

/**
 * The probe is decoration for one link; it must never gate signing in. Exposed as an
 * explicit rule so the guarantee is testable rather than implied by the screen's wiring.
 */
export function canAttemptLogin(probe: RecoveryProbeState): boolean {
  void probe;
  return true;
}

/**
 * Same normalization the login and registration screens apply before sending credentials,
 * so a member who types a trailing space gets identical treatment in every flow.
 */
export function normalizeRecoveryEmail(raw: string): string {
  return raw.trim();
}

/**
 * Guard for the forgot-password submit: blocks empty input and prevents a second request
 * while one is already in flight (double-tap on a slow connection).
 */
export function canSubmitRecoveryRequest(rawEmail: string, busy: boolean): boolean {
  return !busy && normalizeRecoveryEmail(rawEmail).length > 0;
}
