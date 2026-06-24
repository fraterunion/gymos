import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { fetchPublicStudio, type PublicStudioDto } from '@/lib/api/publicDiscoveryApi';
import { getStudioSlug } from '@/lib/env';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';

type PublicStudioContextValue = {
  studio: PublicStudioDto | null;
  studioId: string | null;
  /** Falls back to 'UTC' while loading or on error. */
  timezone: string;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
};

const PublicStudioContext = createContext<PublicStudioContextValue | null>(null);

export function PublicStudioProvider({ children }: { children: ReactNode }) {
  const [studio, setStudio] = useState<PublicStudioDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const slug = getStudioSlug();
    if (!slug) {
      setStudio(null);
      setError('A la app le falta la configuración del estudio.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPublicStudio(slug);
      setStudio(data);
    } catch (e) {
      setStudio(null);
      setError(userFacingApiMessage(e, 'No se pudo cargar la información del estudio.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo<PublicStudioContextValue>(
    () => ({
      studio,
      studioId: studio?.id ?? null,
      timezone: studio?.timezone ?? 'UTC',
      loading,
      error,
      refetch: load,
    }),
    [studio, loading, error, load],
  );

  return <PublicStudioContext.Provider value={value}>{children}</PublicStudioContext.Provider>;
}

export function usePublicStudio(): PublicStudioContextValue {
  const ctx = useContext(PublicStudioContext);
  if (!ctx) {
    throw new Error('usePublicStudio must be used within PublicStudioProvider');
  }
  return ctx;
}
