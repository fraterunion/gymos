export const WALLET_APPLE_NOT_CONFIGURED_MESSAGE = 'WALLET_APPLE_NOT_CONFIGURED';

/**
 * Env vars required to sign a real pass. All absent by design in this environment — no
 * Apple Developer enrollment exists yet (see Phase A/B external-setup checklist). The
 * provider must fail with WALLET_APPLE_NOT_CONFIGURED, not a raw crypto exception, when
 * any of these are missing.
 *
 * WALLET_APPLE_TEAM_ID           — Apple Developer Team ID
 * WALLET_APPLE_PASS_TYPE_ID      — registered Pass Type ID, e.g. "pass.co.gymos.member"
 * WALLET_APPLE_SIGNING_CERT_P12_BASE64 — Pass Type ID certificate + private key, base64-encoded .p12
 * WALLET_APPLE_SIGNING_CERT_PASSWORD   — password protecting the .p12
 * WALLET_APPLE_WWDR_CERT_PEM_BASE64    — Apple WWDR intermediate certificate, base64-encoded PEM
 */
export const APPLE_WALLET_ENV_KEYS = [
  'WALLET_APPLE_TEAM_ID',
  'WALLET_APPLE_PASS_TYPE_ID',
  'WALLET_APPLE_SIGNING_CERT_P12_BASE64',
  'WALLET_APPLE_SIGNING_CERT_PASSWORD',
  'WALLET_APPLE_WWDR_CERT_PEM_BASE64',
] as const;

export const PASS_FORMAT_VERSION = 1;
