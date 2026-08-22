/**
 * A pre-existing WalletCredential has no artifact yet for the requested platform, and no raw
 * value is available to provision one (Phase 1 never persists it) — the client must ask the
 * member to explicitly reissue. This is never thrown for a member's very first pass request.
 */
export const WALLET_PASS_REISSUE_REQUIRED_MESSAGE = 'WALLET_PASS_REISSUE_REQUIRED';
export const WALLET_MEMBER_NOT_ACTIVE_MESSAGE = 'WALLET_MEMBER_NOT_ACTIVE';
/**
 * Structurally should be unreachable (see WalletPassService.recoverBarcode) — an Apple
 * artifact and a Google artifact for the SAME WalletCredential row resolved to different
 * underlying credentials. Never silently pick one; this is a distinct backend-only signal
 * for logging/alerting. The mobile client classifies it the same as reissue-required —
 * there is no member-facing distinction between "unrecoverable" and "recovery integrity
 * failure," both mean "we can't safely show your pass, please reset."
 */
export const WALLET_RECOVERY_INTEGRITY_ERROR_MESSAGE = 'WALLET_RECOVERY_INTEGRITY_ERROR';
/** A short-lived Apple pkpass download token was missing, expired, malformed, or scoped to
 *  a different studio/artifact than the one requested. */
export const WALLET_DOWNLOAD_TOKEN_INVALID_MESSAGE = 'WALLET_DOWNLOAD_TOKEN_INVALID';
