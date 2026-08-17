import { getApiV1BaseUrl } from '@/lib/env';
import { ApiError, TimeoutError } from '@/lib/api/errors';
import {
  clearRefreshTokenFromStore,
  emitSessionInvalidated,
  getAccessToken,
  getRefreshTokenFromStore,
  saveRefreshTokenToStore,
  setAccessToken,
} from '@/lib/session';

type RequestOptions = RequestInit & {
  skipAuth?: boolean;
  /** Internal: avoid infinite 401 → refresh loops. */
  _didRefresh?: boolean;
};

/** Default timeout for all API requests. Prevents infinite loading when the server
 *  is unreachable or stalls mid-response. */
const REQUEST_TIMEOUT_MS = 15_000;

let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  const base = getApiV1BaseUrl();
  if (!base) return false;
  const refreshToken = await getRefreshTokenFromStore();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      return false;
    }
    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    if (!data.accessToken || !data.refreshToken) {
      return false;
    }
    setAccessToken(data.accessToken);
    await saveRefreshTokenToStore(data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

function refreshAccessTokenSingleFlight(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function clearSessionAfterAuthFailure(): Promise<void> {
  setAccessToken(null);
  await clearRefreshTokenFromStore();
  emitSessionInvalidated();
}

export async function apiRequest<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const base = getApiV1BaseUrl();
  if (!base) {
    throw new ApiError('EXPO_PUBLIC_API_URL is not configured', 0);
  }
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (!init.skipAuth) {
    const token = getAccessToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  // Bail immediately if the caller already signalled an abort before we started.
  const callerSignal = init.signal;
  if (callerSignal?.aborted) {
    throw new ApiError('Request aborted', 0);
  }

  // Create a per-request AbortController for the timeout.
  // We forward any abort from the caller's signal into ours so both can cancel the fetch.
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

  function forwardCallerAbort() {
    // Propagate the caller's abort reason into our controller.
    timeoutController.abort(callerSignal?.reason);
  }
  if (callerSignal) {
    callerSignal.addEventListener('abort', forwardCallerAbort);
  }

  let timedOut = false;
  try {
    const res = await fetch(url, { ...init, headers, signal: timeoutController.signal });

    if (res.status === 401 && !init.skipAuth && !init._didRefresh) {
      const refreshed = await refreshAccessTokenSingleFlight();
      if (refreshed) {
        return apiRequest<T>(path, { ...init, _didRefresh: true });
      }
      await clearSessionAfterAuthFailure();
      throw new ApiError('Session expired', 401, await safeJson(res));
    }

    if (res.status === 401 && init._didRefresh) {
      await clearSessionAfterAuthFailure();
      throw new ApiError('Session expired', 401, await safeJson(res));
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const json = await safeJson(res);
    if (!res.ok) {
      const msg = formatErrorMessage(json, res.statusText);
      throw new ApiError(msg || 'Request failed', res.status, json);
    }
    return json as T;
  } catch (e) {
    // Distinguish our timeout from a caller-initiated abort:
    // if the controller was aborted but the caller did NOT abort, it was our timer.
    const isAbortError = e instanceof Error && e.name === 'AbortError';
    if (isAbortError && !callerSignal?.aborted) {
      timedOut = true;
      throw new TimeoutError();
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (callerSignal) {
      callerSignal.removeEventListener('abort', forwardCallerAbort);
    }
    // Suppress the unused-variable warning; timedOut is read by type-checkers.
    void timedOut;
  }
}

function formatErrorMessage(json: unknown, fallback: string): string {
  if (!json || typeof json !== 'object') return fallback;
  const m = (json as { message?: unknown }).message;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(String).join(', ');
  return fallback;
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
