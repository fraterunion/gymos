/**
 * Minimal client for the PUBLIC password-recovery endpoints.
 *
 * This site is a member-facing surface with no session of its own, so there is deliberately
 * no auth, refresh or storage machinery here — only the three unauthenticated calls the
 * recovery flow needs. The reset token is passed straight through to the API and is never
 * stored, logged or sent anywhere else.
 */

export class RecoveryApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RecoveryApiError';
  }
}

export function getApiBase(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL;
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return '';
  return `${raw.trim().replace(/\/+$/, '')}/api/v1`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getApiBase();
  if (!base) {
    throw new RecoveryApiError('NEXT_PUBLIC_API_URL is not configured', 0);
  }
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const message =
      body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : 'Request failed';
    throw new RecoveryApiError(message, res.status);
  }
  return body as T;
}

export type AuthCapabilities = { passwordRecoveryEnabled: boolean };

export function fetchAuthCapabilities(): Promise<AuthCapabilities> {
  return request<AuthCapabilities>('/auth/capabilities', { method: 'GET' });
}

export function forgotPasswordRequest(email: string, studioSlug?: string): Promise<{ message: string }> {
  return request<{ message: string }>('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email, ...(studioSlug ? { studioSlug } : {}) }),
  });
}

export function resetPasswordRequest(token: string, newPassword: string): Promise<{ message: string }> {
  return request<{ message: string }>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  });
}

export type PublicStudioBranding = {
  slug: string;
  name: string;
  appName: string | null;
  brandPrimaryColor: string | null;
  brandLogoUrl: string | null;
  supportEmail: string | null;
};

/** Slug shape the API issues; keeps a hostile link from probing other paths. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidStudioSlug(slug: string | null | undefined): slug is string {
  return typeof slug === 'string' && SLUG.test(slug);
}

export function safeBrandColor(value: string | null | undefined): string | null {
  return typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim() : null;
}

export function fetchPublicStudioBranding(slug: string): Promise<PublicStudioBranding> {
  return request<PublicStudioBranding>(
    `/public/studios/${encodeURIComponent(slug)}/branding`,
    { method: 'GET' },
  );
}
