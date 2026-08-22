import { createHash, randomBytes } from 'node:crypto';

/**
 * Barcode format for the member identity credential (Apple Wallet / Google Wallet / in-app
 * "Mi Pase"). "v1" is not decorative: an already-issued physical pass can sit on a member's
 * phone for months, so the parser must be able to distinguish format generations forever.
 */
export const WALLET_CREDENTIAL_PREFIX = 'gymos:v1:';

/** randomBytes(32) base64url-encoded is 43 chars with no padding — anything shorter is malformed. */
export const WALLET_CREDENTIAL_MIN_RAW_LENGTH = 32;

export function generateRawWalletCredential(): string {
  return randomBytes(32).toString('base64url');
}

export function hashWalletCredential(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function isWalletCredentialBarcode(value: string): boolean {
  return value.startsWith(WALLET_CREDENTIAL_PREFIX);
}

export function buildWalletCredentialBarcode(raw: string): string {
  return `${WALLET_CREDENTIAL_PREFIX}${raw}`;
}
