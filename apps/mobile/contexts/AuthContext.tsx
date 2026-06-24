import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { loginRequest, logoutRequest, meRequest, registerRequest, type RegisterBody } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import { getApiV1BaseUrl } from '@/lib/env';
import {
  clearRefreshTokenFromStore,
  getRefreshTokenFromStore,
  saveRefreshTokenToStore,
  setAccessToken,
  subscribeSessionInvalidated,
} from '@/lib/session';
import type { AuthUser } from '@/lib/types';

type AuthContextValue = {
  user: AuthUser | null;
  hydrated: boolean;
  busy: boolean;
  error: string | null;
  clearError: () => void;
  login: (email: string, password: string) => Promise<void>;
  register: (body: RegisterBody) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function refreshWithStoredToken(): Promise<AuthUser | null> {
  const base = getApiV1BaseUrl();
  if (!base) return null;
  const refreshToken = await getRefreshTokenFromStore();
  if (!refreshToken) return null;
  const res = await fetch(`${base}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    await clearRefreshTokenFromStore();
    setAccessToken(null);
    return null;
  }
  const data = (await res.json()) as { accessToken: string; refreshToken: string };
  setAccessToken(data.accessToken);
  await saveRefreshTokenToStore(data.refreshToken);
  try {
    return await meRequest();
  } catch {
    await clearRefreshTokenFromStore();
    setAccessToken(null);
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return subscribeSessionInvalidated(() => {
      setUser(null);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await refreshWithStoredToken();
        if (!cancelled) setUser(me);
      } catch {
        if (!cancelled) {
          await clearRefreshTokenFromStore();
          setAccessToken(null);
          setUser(null);
        }
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const bundle = await loginRequest(email, password);
      setAccessToken(bundle.accessToken);
      await saveRefreshTokenToStore(bundle.refreshToken);
      const me = await meRequest();
      setUser(me);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'No se pudo iniciar sesión';
      setError(msg);
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const register = useCallback(async (body: RegisterBody) => {
    setBusy(true);
    setError(null);
    try {
      const bundle = await registerRequest(body);
      setAccessToken(bundle.accessToken);
      await saveRefreshTokenToStore(bundle.refreshToken);
      const me = await meRequest();
      setUser(me);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'No se pudo crear la cuenta';
      setError(msg);
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const logout = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const rt = await getRefreshTokenFromStore();
      if (rt) {
        try {
          await logoutRequest(rt);
        } catch {
          // best-effort
        }
      }
    } finally {
      setAccessToken(null);
      await clearRefreshTokenFromStore();
      setUser(null);
      setBusy(false);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      hydrated,
      busy,
      error,
      clearError,
      login,
      register,
      logout,
    }),
    [user, hydrated, busy, error, clearError, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
