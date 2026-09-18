/**
 * The ONE password policy for the platform. Registration, password reset and
 * authenticated password change all validate through this module — there must never be
 * three divergent validators.
 *
 * The minimum length is deliberately unchanged from what registration has always
 * enforced (8 characters): tightening it here would retroactively lock out existing
 * members whose passwords were accepted under the old rule, and would change the
 * user-facing contract without a product decision.
 *
 * The maximum IS new, and it is a correctness fix rather than a tightening: bcrypt
 * silently ignores everything past 72 bytes, so a longer password would appear to be
 * accepted while only its first 72 bytes actually protected the account. Rejecting it
 * explicitly is safer than truncating silently.
 */

export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt only hashes the first 72 BYTES; anything beyond that is silently discarded. */
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_POLICY_MESSAGE = `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
export const PASSWORD_TOO_LONG_MESSAGE = `La contraseña es demasiado larga (máximo ${PASSWORD_MAX_BYTES} bytes).`;
export const PASSWORD_SAME_AS_CURRENT_MESSAGE =
  'La nueva contraseña debe ser diferente a la actual.';

export type PasswordPolicyResult = { valid: true } | { valid: false; message: string };

export function describePasswordPolicy(): string {
  return PASSWORD_POLICY_MESSAGE;
}

/**
 * Pure validation shared by every entry point. Returns a message safe to show a user —
 * it never echoes the password back and never reveals anything about the account.
 */
export function validatePassword(password: unknown): PasswordPolicyResult {
  if (typeof password !== 'string') {
    return { valid: false, message: PASSWORD_POLICY_MESSAGE };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { valid: false, message: PASSWORD_POLICY_MESSAGE };
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return { valid: false, message: PASSWORD_TOO_LONG_MESSAGE };
  }
  return { valid: true };
}

export function isPasswordAcceptable(password: unknown): boolean {
  return validatePassword(password).valid;
}
