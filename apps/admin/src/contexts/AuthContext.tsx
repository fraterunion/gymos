"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { loginRequest, logoutRequest, meRequest, type AuthUser } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/errors";
import { getApiV1Base } from "@/lib/env";
import {
  clearSession,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
} from "@/lib/auth/session";

type AuthContextValue = {
  user: AuthUser | null;
  hydrated: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function refreshSession(): Promise<AuthUser | null> {
  const base = getApiV1Base();
  if (!base) return null;
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  const res = await fetch(`${base}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    clearSession();
    return null;
  }
  const data = (await res.json()) as { accessToken: string; refreshToken: string };
  setAccessToken(data.accessToken);
  setRefreshToken(data.refreshToken);
  try {
    return await meRequest();
  } catch {
    clearSession();
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await refreshSession();
        if (!cancelled) setUser(me);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const bundle = await loginRequest(email.trim(), password);
      setAccessToken(bundle.accessToken);
      setRefreshToken(bundle.refreshToken);
      setUser(bundle.user);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Could not sign in";
      setError(msg);
      throw e;
    }
  }, []);

  const logout = useCallback(async () => {
    setError(null);
    try {
      const rt = getRefreshToken();
      if (rt) {
        try {
          await logoutRequest(rt);
        } catch {
          // best-effort
        }
      }
    } finally {
      clearSession();
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      hydrated,
      error,
      login,
      logout,
    }),
    [user, hydrated, error, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
