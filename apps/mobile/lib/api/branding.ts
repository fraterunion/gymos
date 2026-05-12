import { getApiV1BaseUrl } from '@/lib/env';
import { ApiError } from '@/lib/api/errors';
import type { PublicBranding } from '@/lib/types';

export async function fetchPublicBrandingBySlug(slug: string): Promise<PublicBranding> {
  const base = getApiV1BaseUrl();
  if (!base) {
    throw new ApiError('EXPO_PUBLIC_API_URL is not configured', 0);
  }
  const url = `${base}/public/studios/${encodeURIComponent(slug)}/branding`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const msg =
      json && typeof json === 'object' && 'message' in json
        ? String((json as { message: unknown }).message)
        : res.statusText;
    throw new ApiError(msg || 'Branding request failed', res.status, json);
  }
  return json as PublicBranding;
}
