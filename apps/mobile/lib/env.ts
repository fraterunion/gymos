/**
 * Public env (inlined at build time by Metro). See docs/MOBILE.md.
 */

import Constants from 'expo-constants';

export function getPublicApiUrl(): string {
  const raw = process.env.EXPO_PUBLIC_API_URL;
  if (!raw || typeof raw !== 'string' || raw.trim() === '') {
    return '';
  }
  return raw.replace(/\/+$/, '');
}

export function getStudioSlug(): string {
  const raw = process.env.EXPO_PUBLIC_STUDIO_SLUG;
  if (!raw || typeof raw !== 'string') {
    return '';
  }
  return raw.trim();
}

export function getApiV1BaseUrl(): string {
  const base = getPublicApiUrl();
  if (!base) return '';
  return `${base}/api/v1`;
}

/** Value of `WHITELABEL_PROFILE` baked into the native build via `app.config.ts` `extra`. */
export function getWhitelabelBuildProfile(): string {
  const extra = Constants.expoConfig?.extra as { whitelabelProfile?: unknown } | undefined;
  const v = extra?.whitelabelProfile;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : 'local';
}
