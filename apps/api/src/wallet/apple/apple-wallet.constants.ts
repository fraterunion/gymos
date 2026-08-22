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

/**
 * Presentation version of the .pkpass this codebase produces. A signed pass is persisted as a
 * WalletPassArtifact and served verbatim forever, so shipping a new design does NOT reach any
 * member who already has an artifact — and deleting the pass from the iPhone does not touch
 * the stored row. This constant is the invalidation signal: an artifact recorded with a
 * different version is rebuilt from the SAME WalletCredential on next access.
 *
 * BUMP THIS whenever buildPassJson's structure or the bundled brand assets change.
 * `apple-pass-template-fingerprint.spec.ts` fails if you forget.
 *
 *   1 — initial static pass: no logo, plan in secondaryFields, studio accent as background
 *   2 — Member Experience 1.2: brand logo images, plan in headerFields, graphite surface
 */
export const APPLE_PASS_TEMPLATE_VERSION = 2;
