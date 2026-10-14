import { createHash } from 'node:crypto';
import {
  generatePassAuthenticationToken,
  hashPassAuthenticationToken,
  isWellFormedPassAuthenticationToken,
  parseApplePassAuthorization,
  verifyPassAuthenticationToken,
} from './passkit-token';

describe('PassKit authentication token', () => {
  it('is 43 base64url characters (32 random bytes), above Apple\'s 16-character minimum, and unique', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generatePassAuthenticationToken()));
    expect(tokens.size).toBe(200);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isWellFormedPassAuthenticationToken(t)).toBe(true);
    }
  });

  it('stores only a SHA-256 hex digest', () => {
    const token = generatePassAuthenticationToken();
    const hash = hashPassAuthenticationToken(token);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it('verifies only the exact token against its stored hash', () => {
    const token = generatePassAuthenticationToken();
    const hash = hashPassAuthenticationToken(token);
    expect(verifyPassAuthenticationToken(token, hash)).toBe(true);
    expect(verifyPassAuthenticationToken(generatePassAuthenticationToken(), hash)).toBe(false);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyPassAuthenticationToken(flipped, hash)).toBe(false);
  });

  it('fails closed on a missing, malformed or non-hex stored hash, and on malformed tokens', () => {
    const token = generatePassAuthenticationToken();
    expect(verifyPassAuthenticationToken(token, null)).toBe(false);
    expect(verifyPassAuthenticationToken(token, undefined)).toBe(false);
    expect(verifyPassAuthenticationToken(token, '')).toBe(false);
    expect(verifyPassAuthenticationToken(token, 'z'.repeat(64))).toBe(false);
    expect(verifyPassAuthenticationToken('short', hashPassAuthenticationToken('short'))).toBe(false);
    expect(verifyPassAuthenticationToken(`${token}!`, hashPassAuthenticationToken(`${token}!`))).toBe(false);
  });

  it('parses only "ApplePass <token>"', () => {
    const token = generatePassAuthenticationToken();
    expect(parseApplePassAuthorization(`ApplePass ${token}`)).toBe(token);
    expect(parseApplePassAuthorization(undefined)).toBeNull();
    expect(parseApplePassAuthorization('')).toBeNull();
    expect(parseApplePassAuthorization(`Bearer ${token}`)).toBeNull();
    expect(parseApplePassAuthorization(`applepass ${token}`)).toBeNull();
    expect(parseApplePassAuthorization(token)).toBeNull();
    expect(parseApplePassAuthorization('ApplePass ')).toBeNull();
    expect(parseApplePassAuthorization('ApplePass not a token at all')).toBeNull();
    expect(parseApplePassAuthorization([`ApplePass ${token}`])).toBeNull();
    expect(parseApplePassAuthorization(`ApplePass ${'a'.repeat(600)}`)).toBeNull();
  });
});
