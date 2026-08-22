export const WALLET_GOOGLE_NOT_CONFIGURED_MESSAGE = 'WALLET_GOOGLE_NOT_CONFIGURED';

/**
 * Env vars required to talk to the real Google Wallet API. All absent by design — no
 * Google Wallet issuer account exists yet (see external-setup checklist).
 *
 * WALLET_GOOGLE_ISSUER_ID                    — Google Wallet issuer ID (from the Wallet console)
 * WALLET_GOOGLE_SERVICE_ACCOUNT_EMAIL         — service account client_email
 * WALLET_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64 — service account private_key, base64-encoded PEM
 */
export const GOOGLE_WALLET_ENV_KEYS = [
  'WALLET_GOOGLE_ISSUER_ID',
  'WALLET_GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'WALLET_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_BASE64',
] as const;

export const GOOGLE_WALLET_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_WALLET_API_BASE = 'https://walletobjects.googleapis.com/walletobjects/v1';
export const GOOGLE_WALLET_SAVE_BASE_URL = 'https://pay.google.com/gp/v/save/';
