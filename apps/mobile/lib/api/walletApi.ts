import { apiRequest } from '@/lib/api/client';

export type WalletBarcodeResponse = {
  barcode: string | null;
  isNew: boolean;
};

export type AppleDownloadLinkResponse = {
  downloadUrl: string;
  expiresInSeconds: number;
};

export type GoogleSaveResponse = {
  saveUrl: string;
};

export type WalletMultipleCandidatesBody = {
  code: 'WALLET_MULTIPLE_ELIGIBLE_BOOKINGS';
  candidates: Array<{ bookingId: string; scheduledClassId: string; className: string; startsAt: string }>;
};

export type WalletReissueResponse = {
  barcode: string;
  applePkpassAvailable: boolean;
  googleWalletAvailable: boolean;
};

/**
 * The member's own permanent identity credential — the SAME barcode Apple/Google Wallet
 * represent, rendered in-app. Non-null on first-ever issuance AND (Phase 3.2) whenever the
 * backend can safely recover it from an already-provisioned Apple/Google artifact — a second
 * device, a reinstall, or a lost local cache no longer requires a reset. The caller still
 * caches it locally (see walletCredentialStore.ts) so this endpoint isn't hit again; `null`
 * now means genuinely unrecoverable (no local cache, no credential ever issued for this
 * device to remember, AND no Wallet artifact exists anywhere to recover from).
 */
export async function fetchWalletBarcode(studioId: string): Promise<WalletBarcodeResponse> {
  return apiRequest<WalletBarcodeResponse>(`/studios/${studioId}/wallet/credential`, {
    method: 'POST',
    body: '{}',
  });
}

/**
 * Explicit member-initiated security reset — the ONLY path that rotates the credential.
 * Must only ever be called after the member has confirmed the "Actualizar pase" dialog; it
 * immediately invalidates any previously-added Apple/Google Wallet pass and any screenshot
 * of the old QR.
 */
export async function fetchWalletReissue(studioId: string): Promise<WalletReissueResponse> {
  return apiRequest<WalletReissueResponse>(`/studios/${studioId}/wallet/reissue`, {
    method: 'POST',
    body: '{}',
  });
}

/** Short-lived (90s) URL to open in an in-app browser to trigger the native Apple Wallet handoff. */
export async function fetchAppleWalletDownloadLink(studioId: string): Promise<AppleDownloadLinkResponse> {
  return apiRequest<AppleDownloadLinkResponse>(`/studios/${studioId}/wallet/apple/download-link`, {
    method: 'POST',
    body: '{}',
  });
}

export async function fetchGoogleWalletSaveUrl(studioId: string): Promise<GoogleSaveResponse> {
  return apiRequest<GoogleSaveResponse>(`/studios/${studioId}/wallet/google`, {
    method: 'POST',
    body: '{}',
  });
}
