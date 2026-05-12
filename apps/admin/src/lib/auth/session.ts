const REFRESH_KEY = "gymos_admin_refresh_v1";

/** In-memory only — never persist access token. */
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function setRefreshToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REFRESH_KEY, token);
}

export function clearRefreshToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(REFRESH_KEY);
  } catch {
    // ignore
  }
}

export function clearSession(): void {
  accessToken = null;
  clearRefreshToken();
}
