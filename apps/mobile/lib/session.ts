import * as SecureStore from 'expo-secure-store';

const REFRESH_TOKEN_KEY = 'gymos_refresh_token_v1';

/** In-memory only — never persist. */
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export async function getRefreshTokenFromStore(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function saveRefreshTokenToStore(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

export async function clearRefreshTokenFromStore(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  } catch {
    // ignore
  }
}

const sessionListeners = new Set<() => void>();

export function subscribeSessionInvalidated(cb: () => void): () => void {
  sessionListeners.add(cb);
  return () => {
    sessionListeners.delete(cb);
  };
}

export function emitSessionInvalidated(): void {
  for (const cb of sessionListeners) {
    cb();
  }
}
