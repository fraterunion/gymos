import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * PassKit `authenticationToken` — the per-pass shared secret a device sends back as
 * `Authorization: ApplePass <token>` when it registers, unregisters or fetches an update.
 *
 * - 32 random bytes, base64url: 43 characters, well above Apple's 16-character minimum and
 *   header-safe without escaping.
 * - The server stores only its SHA-256 (hex). The raw value lives inside the signed pass the
 *   member holds (pass.json is signed, not encrypted — the same exposure the barcode already
 *   has), which is also where a rebuild recovers it from: Apple requires the token to stay the
 *   same across updates to a pass, so it is never regenerated for an existing dynamic pass.
 * - Comparison is constant-time over fixed-length digests.
 */
export const PASS_AUTH_TOKEN_BYTES = 32;
export const PASS_AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const APPLE_PASS_SCHEME = 'ApplePass ';
/** Upper bound on an Authorization header we are willing to parse at all. */
const MAX_AUTHORIZATION_HEADER_LENGTH = 512;

export function generatePassAuthenticationToken(): string {
  return randomBytes(PASS_AUTH_TOKEN_BYTES).toString('base64url');
}

export function hashPassAuthenticationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isWellFormedPassAuthenticationToken(token: unknown): token is string {
  return typeof token === 'string' && PASS_AUTH_TOKEN_PATTERN.test(token);
}

/** Constant-time check of a presented token against a stored SHA-256 hex digest. */
export function verifyPassAuthenticationToken(token: string, expectedHashHex: string | null | undefined): boolean {
  if (!expectedHashHex || !/^[0-9a-f]{64}$/.test(expectedHashHex)) return false;
  if (!isWellFormedPassAuthenticationToken(token)) return false;
  const presented = createHash('sha256').update(token, 'utf8').digest();
  const expected = Buffer.from(expectedHashHex, 'hex');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * Extracts the token from `Authorization: ApplePass <token>`. Returns null for anything else
 * (missing, other scheme, oversized, malformed token) so callers answer 401 uniformly.
 */
export function parseApplePassAuthorization(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string' || header.length > MAX_AUTHORIZATION_HEADER_LENGTH) return null;
  if (!header.startsWith(APPLE_PASS_SCHEME)) return null;
  const token = header.slice(APPLE_PASS_SCHEME.length).trim();
  return isWellFormedPassAuthenticationToken(token) ? token : null;
}
