import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';

import { useBranding } from '@/contexts/BrandingContext';

export type SelectedStudio = {
  slug: string;
  displayName: string;
  timezone: string | null;
};

const StudioContext = createContext<SelectedStudio | null>(null);

/**
 * White-label app is bound to a single studio via `EXPO_PUBLIC_STUDIO_SLUG`.
 * Branding boot fills display metadata from the API.
 */
export function SelectedStudioProvider({ children }: { children: ReactNode }) {
  const { slug, appDisplayName, branding } = useBranding();

  const value = useMemo<SelectedStudio>(
    () => ({
      slug,
      displayName: appDisplayName,
      timezone: branding?.timezone ?? null,
    }),
    [slug, appDisplayName, branding?.timezone],
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useSelectedStudio(): SelectedStudio {
  const ctx = useContext(StudioContext);
  if (!ctx) {
    throw new Error('useSelectedStudio must be used within SelectedStudioProvider');
  }
  return ctx;
}
