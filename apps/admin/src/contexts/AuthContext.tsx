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

import {
  changePasswordRequest,
  loginRequest,
  logoutRequest,
  meRequest,
  type AuthUser,
} from "@/lib/api/auth";
import { clearStoredStudioId } from "@/lib/studioStorage";
import { userFacingApiMessage } from "@/lib/userFacingApiMessage";
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
  /** Changes the password and adopts the fresh session the server returns. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
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
      const msg = userFacingApiMessage(e, "Could not sign in. Check your email and password.");
      setError(msg);
      throw e;
    }
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    // The server revokes every session and returns new credentials for THIS browser, so
    // they must replace the stored ones or the next request would 401.
    const bundle = await changePasswordRequest(currentPassword, newPassword);
    setAccessToken(bundle.accessToken);
    setRefreshToken(bundle.refreshToken);
    setUser(bundle.user);
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
      clearStoredStudioId();
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
      changePassword,
    }),
    [user, hydrated, error, login, logout, changePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
