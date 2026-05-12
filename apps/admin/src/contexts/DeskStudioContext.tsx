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

import { fetchMyStudios, type MyStudioRow } from "@/lib/api/meStudios";
import { ApiError } from "@/lib/api/errors";

const STORAGE_KEY = "gymos_admin_studio_id";

type DeskStudioContextValue = {
  studios: MyStudioRow[];
  selectedStudioId: string | null;
  selected: MyStudioRow | null;
  loading: boolean;
  error: string | null;
  setStudioId: (id: string) => void;
  reload: () => Promise<void>;
};

const DeskStudioContext = createContext<DeskStudioContextValue | null>(null);

function readStoredStudioId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredStudioId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore
  }
}

export function DeskStudioProvider({ children }: { children: ReactNode }) {
  const [studios, setStudios] = useState<MyStudioRow[]>([]);
  const [selectedStudioId, setSelectedStudioIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchMyStudios();
      setStudios(rows);
      const stored = readStoredStudioId();
      const hit = stored ? rows.find((r) => r.studio.id === stored) : null;
      const nextId = hit?.studio.id ?? rows[0]?.studio.id ?? null;
      setSelectedStudioIdState(nextId);
      if (nextId) writeStoredStudioId(nextId);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Could not load studios";
      setError(msg);
      setStudios([]);
      setSelectedStudioIdState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void reload(), 0);
    return () => clearTimeout(t);
  }, [reload]);

  const setStudioId = useCallback((id: string) => {
    setSelectedStudioIdState(id);
    writeStoredStudioId(id);
  }, []);

  const selected = useMemo(() => {
    if (!selectedStudioId) return null;
    return studios.find((r) => r.studio.id === selectedStudioId) ?? null;
  }, [studios, selectedStudioId]);

  const value = useMemo<DeskStudioContextValue>(
    () => ({
      studios,
      selectedStudioId,
      selected,
      loading,
      error,
      setStudioId,
      reload,
    }),
    [studios, selectedStudioId, selected, loading, error, setStudioId, reload],
  );

  return <DeskStudioContext.Provider value={value}>{children}</DeskStudioContext.Provider>;
}

export function useDeskStudio(): DeskStudioContextValue {
  const ctx = useContext(DeskStudioContext);
  if (!ctx) throw new Error("useDeskStudio must be used within DeskStudioProvider");
  return ctx;
}
