export type WalletEventName =
  | 'member_pass_viewed'
  | 'apple_wallet_add_started'
  | 'apple_wallet_add_completed'
  | 'google_wallet_add_started'
  | 'google_wallet_add_opened'
  | 'member_pass_error'
  | 'member_pass_reset_confirmed'
  | 'member_pass_reset_succeeded'
  | 'member_pass_reset_failed';

/**
 * This app has no product-analytics vendor integrated today (checked — no Segment/Amplitude/
 * PostHog/Mixpanel anywhere in the mobile codebase), and this feature is not the place to
 * introduce one. This logs the same structured-event shape the backend already uses
 * (`JSON.stringify({event, ...})`) to the console in development only, so the event names
 * and payloads are already in the exact shape a real vendor call would need later — wiring
 * one in becomes a one-line change in this single file, not a feature rewrite.
 * NEVER pass barcode/rawCredential/walletCredentialId in `extra` — studioId and coarse
 * context only.
 */
export function logWalletEvent(name: WalletEventName, extra: Record<string, string> = {}): void {
  if (!__DEV__) return;
  console.log(JSON.stringify({ event: name, ...extra }));
}
