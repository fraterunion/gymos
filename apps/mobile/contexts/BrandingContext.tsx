import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { fetchPublicBrandingBySlug } from '@/lib/api/branding';
import { ApiError } from '@/lib/api/errors';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';
import { getStudioSlug } from '@/lib/env';
import type { PublicBranding } from '@/lib/types';

const DEFAULT_PRIMARY = '#64748b';
const DEFAULT_SECONDARY = '#94a3b8';

type BrandingStatus = 'loading' | 'ready' | 'error';

type BrandingContextValue = {
  status: BrandingStatus;
  slug: string;
  branding: PublicBranding | null;
  error: ApiError | Error | null;
  /** Display name for headers (appName → name → slug). */
  appDisplayName: string;
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string | null;
  retry: () => void;
};

const BrandingContext = createContext<BrandingContextValue | null>(null);

function resolveColors(branding: PublicBranding | null): { primary: string; secondary: string } {
  return {
    primary: branding?.brandPrimaryColor?.trim() || DEFAULT_PRIMARY,
    secondary: branding?.brandSecondaryColor?.trim() || DEFAULT_SECONDARY,
  };
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const slug = useMemo(() => getStudioSlug(), []);
  const [status, setStatus] = useState<BrandingStatus>('loading');
  const [branding, setBranding] = useState<PublicBranding | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const load = useCallback(async () => {
    if (!slug) {
      setError(new Error('A esta versión de la app le faltan ajustes del estudio. Pídele a tu estudio una versión actualizada.'));
      setStatus('error');
      setBranding(null);
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      const data = await fetchPublicBrandingBySlug(slug);
      setBranding(data);
      setStatus('ready');
    } catch (e) {
      setBranding(null);
      const msg =
        e instanceof ApiError
          ? userFacingApiMessage(e, 'No pudimos cargar este estudio. Revisa tu conexión e inténtalo de nuevo.')
          : e instanceof Error
            ? e.message
            : 'No pudimos cargar este estudio. Revisa tu conexión e inténtalo de nuevo.';
      setError(new Error(msg));
      setStatus('error');
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const { primary, secondary } = resolveColors(branding);
  const appDisplayName = branding?.appName?.trim() || branding?.name?.trim() || slug || 'Estudio';

  const value = useMemo<BrandingContextValue>(
    () => ({
      status,
      slug,
      branding,
      error,
      appDisplayName,
      primaryColor: primary,
      secondaryColor: secondary,
      logoUrl: branding?.brandLogoUrl ?? null,
      retry: load,
    }),
    [status, slug, branding, error, appDisplayName, primary, secondary, load],
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingContextValue {
  const ctx = useContext(BrandingContext);
  if (!ctx) {
    throw new Error('useBranding must be used within BrandingProvider');
  }
  return ctx;
}
