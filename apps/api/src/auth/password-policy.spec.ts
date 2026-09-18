import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_MESSAGE,
  PASSWORD_TOO_LONG_MESSAGE,
  isPasswordAcceptable,
  validatePassword,
} from './password-policy';

describe('shared password policy', () => {
  it('accepts a password at the minimum length', () => {
    expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH))).toEqual({ valid: true });
  });

  it('rejects anything shorter than the minimum with a non-revealing message', () => {
    const result = validatePassword('a'.repeat(PASSWORD_MIN_LENGTH - 1));
    expect(result).toEqual({ valid: false, message: PASSWORD_POLICY_MESSAGE });
    expect(PASSWORD_POLICY_MESSAGE).not.toMatch(/a{3}/); // never echoes the input
  });

  it('keeps the historical minimum of 8 so existing members are not locked out', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
  });

  it('rejects passwords longer than bcrypt can hash instead of silently truncating', () => {
    const tooLong = 'a'.repeat(PASSWORD_MAX_BYTES + 1);
    expect(validatePassword(tooLong)).toEqual({ valid: false, message: PASSWORD_TOO_LONG_MESSAGE });
  });

  it('measures the limit in BYTES, not characters (multi-byte passwords)', () => {
    // 36 emoji = 144 bytes but only 36 code points: a character-based check would pass it
    // and bcrypt would silently ignore half the password.
    const multiByte = '🔐'.repeat(36);
    expect(multiByte.length).toBeLessThanOrEqual(PASSWORD_MAX_BYTES);
    expect(Buffer.byteLength(multiByte, 'utf8')).toBeGreaterThan(PASSWORD_MAX_BYTES);
    expect(isPasswordAcceptable(multiByte)).toBe(false);
  });

  it('accepts a multi-byte password that fits inside the byte budget', () => {
    expect(isPasswordAcceptable('contraseñaSegura')).toBe(true);
  });

  it('rejects non-string input defensively', () => {
    expect(isPasswordAcceptable(undefined)).toBe(false);
    expect(isPasswordAcceptable(null)).toBe(false);
    expect(isPasswordAcceptable(12345678)).toBe(false);
  });
});
