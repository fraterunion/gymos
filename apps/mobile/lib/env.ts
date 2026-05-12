/**
 * Public env (inlined at build time by Metro). See docs/MOBILE.md.
 */
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
