import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { fetchPublicBrandingBySlug } from '@/lib/api/branding';
import { ApiError } from '@/lib/api/errors';
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
      setError(new Error('EXPO_PUBLIC_STUDIO_SLUG is not set'));
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
      setError(e instanceof Error ? e : new Error('Unknown error'));
      setStatus('error');
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const { primary, secondary } = resolveColors(branding);
  const appDisplayName = branding?.appName?.trim() || branding?.name?.trim() || slug || 'Studio';

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
