import * as SecureStore from 'expo-secure-store';

function storageKey(studioId: string, userId: string): string {
  return `gymos_wallet_barcode_v1_${studioId}_${userId}`;
}

/**
 * The backend deliberately never re-supplies the raw Wallet credential after the moment it's
 * first issued (Phase 1/2 principle: never persist it server-side). This is the client-side
 * half of that design — cache it once, locally, in the platform Keychain/Keystore via
 * SecureStore, and never ask the backend for it again. Reopening Mi Pase reads this cache;
 * it never triggers a new issuance or rotates the credential.
 */
export async function getCachedBarcode(studioId: string, userId: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(storageKey(studioId, userId));
  } catch {
    return null;
  }
}

export async function setCachedBarcode(studioId: string, userId: string, barcode: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(storageKey(studioId, userId), barcode);
  } catch {
    // Best-effort — a failed cache write just means the next Mi Pase visit re-fetches.
  }
}

/** Used only after an explicit reissue (not exposed to members this phase) or sign-out. */
export async function clearCachedBarcode(studioId: string, userId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(storageKey(studioId, userId));
  } catch {
    // ignore
  }
}
