import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { fetchMyStudios } from '@/lib/api/meStudios';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getStudioSlug } from '@/lib/env';
import type { MyStudioRow } from '@/lib/types/studio';

import { useAuth } from '@/contexts/AuthContext';

type MemberStudioContextValue = {
  status: 'loading' | 'error' | 'ready';
  /** Matched row for `EXPO_PUBLIC_STUDIO_SLUG`, or null if user is not a member of this studio. */
  matched: MyStudioRow | null;
  error: string | null;
  refetch: () => Promise<void>;
};

const MemberStudioContext = createContext<MemberStudioContextValue | null>(null);

export function MemberStudioProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [matched, setMatched] = useState<MyStudioRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) {
      setMatched(null);
      setError(null);
      setStatus('ready');
      return;
    }
    const slug = getStudioSlug();
    if (!slug) {
      setError('A esta versión de la app le faltan ajustes del estudio. Pídele a tu estudio una versión actualizada.');
      setMatched(null);
      setStatus('error');
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      const rows = await fetchMyStudios();
      const hit = rows.find((r) => r.studio.slug === slug) ?? null;
      setMatched(hit);
      setStatus('ready');
    } catch (e) {
      setError(userFacingApiMessage(e, 'No pudimos cargar tu membresía del estudio. Inténtalo de nuevo.'));
      setMatched(null);
      setStatus('error');
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo<MemberStudioContextValue>(
    () => ({
      status,
      matched,
      error,
      refetch: load,
    }),
    [status, matched, error, load],
  );

  return <MemberStudioContext.Provider value={value}>{children}</MemberStudioContext.Provider>;
}

export function useMemberStudio(): MemberStudioContextValue {
  const ctx = useContext(MemberStudioContext);
  if (!ctx) {
    throw new Error('useMemberStudio must be used within MemberStudioProvider');
  }
  return ctx;
}

export function useMatchedStudio(): MyStudioRow | null {
  return useMemberStudio().matched;
}
