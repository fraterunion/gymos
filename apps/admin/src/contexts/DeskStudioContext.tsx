"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useAuth } from "@/contexts/AuthContext";
import { fetchMyStudios, type MyStudioRow } from "@/lib/api/meStudios";
import { getAccessToken } from "@/lib/auth/session";
import { clearStoredStudioId, readStoredStudioId, writeStoredStudioId } from "@/lib/studioStorage";
import { userFacingApiMessage } from "@/lib/userFacingApiMessage";

type DeskStudioContextValue = {
  studios: MyStudioRow[];
  selectedStudioId: string | null;
  /** Selected studio membership from GET /me/studios (includes studio role). */
  selected: MyStudioRow | null;
  /** Role for the selected studio membership; null until /me/studios has loaded. */
  studioRole: string | null;
  loading: boolean;
  /** True once /me/studios has finished loading for the current signed-in user. */
  ready: boolean;
  error: string | null;
  setStudioId: (id: string) => void;
  reload: () => Promise<void>;
};

const DeskStudioContext = createContext<DeskStudioContextValue | null>(null);

function pickStudioId(rows: MyStudioRow[]): string | null {
  if (rows.length === 0) return null;
  const stored = readStoredStudioId();
  const hit = stored ? rows.find((r) => r.studio.id === stored) : null;
  return hit?.studio.id ?? rows[0]?.studio.id ?? null;
}

export function DeskStudioProvider({ children }: { children: ReactNode }) {
  const { user, hydrated } = useAuth();
  const [studios, setStudios] = useState<MyStudioRow[]>([]);
  const [selectedStudioId, setSelectedStudioIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadRequestId = useRef(0);

  const resetStudioState = useCallback(() => {
    reloadRequestId.current += 1;
    setStudios([]);
    setSelectedStudioIdState(null);
    setError(null);
    setReady(false);
    setLoading(false);
  }, []);

  const reload = useCallback(async () => {
    if (!hydrated || !user) {
      resetStudioState();
      return;
    }

    if (!getAccessToken()) {
      setLoading(true);
      setReady(false);
      const requestId = reloadRequestId.current;
      window.setTimeout(() => {
        if (requestId === reloadRequestId.current && getAccessToken()) {
          void reload();
        }
      }, 0);
      return;
    }

    const requestId = ++reloadRequestId.current;
    setLoading(true);
    setError(null);
    setReady(false);

    try {
      const rows = await fetchMyStudios();
      if (requestId !== reloadRequestId.current) return;

      setStudios(rows);
      const nextId = pickStudioId(rows);
      setSelectedStudioIdState(nextId);
      if (nextId) writeStoredStudioId(nextId);
    } catch (e) {
      if (requestId !== reloadRequestId.current) return;
      const msg = userFacingApiMessage(e, "Could not load your studios. Try again or sign out and back in.");
      setError(msg);
      setStudios([]);
      setSelectedStudioIdState(null);
    } finally {
      if (requestId === reloadRequestId.current) {
        setLoading(false);
        setReady(true);
      }
    }
  }, [hydrated, user, resetStudioState]);

  useEffect(() => {
    if (!hydrated) return;
    if (!user) {
      resetStudioState();
      clearStoredStudioId();
      return;
    }
    void reload();
  }, [hydrated, user?.id, reload, resetStudioState]);

  const setStudioId = useCallback((id: string) => {
    setSelectedStudioIdState(id);
    writeStoredStudioId(id);
  }, []);

  const selected = useMemo(() => {
    if (!selectedStudioId) return null;
    return studios.find((r) => r.studio.id === selectedStudioId) ?? null;
  }, [studios, selectedStudioId]);

  const studioRole = ready && selected ? selected.role : null;

  const value = useMemo<DeskStudioContextValue>(
    () => ({
      studios,
      selectedStudioId,
      selected,
      studioRole,
      loading,
      ready,
      error,
      setStudioId,
      reload,
    }),
    [studios, selectedStudioId, selected, studioRole, loading, ready, error, setStudioId, reload],
  );

  return <DeskStudioContext.Provider value={value}>{children}</DeskStudioContext.Provider>;
}

export function useDeskStudio(): DeskStudioContextValue {
  const ctx = useContext(DeskStudioContext);
  if (!ctx) throw new Error("useDeskStudio must be used within DeskStudioProvider");
  return ctx;
}
