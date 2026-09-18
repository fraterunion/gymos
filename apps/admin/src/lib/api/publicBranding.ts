import { apiRequest } from "@/lib/api/client";

/**
 * Public studio branding, used by the logged-out recovery pages so a member sees their own
 * gym rather than a generic panel.
 *
 * This calls the EXISTING unauthenticated endpoint the mobile app already uses before
 * login (`GET /public/studios/:slug/branding`) — no new API surface was needed. It returns
 * only what a studio publishes about itself (display name, logo, colours, support contact,
 * store links). It exposes no user, membership or account data, and cannot reveal whether
 * an address has an account: the slug comes from the reset link and the same response is
 * already available to anyone who knows the slug.
 */

export type PublicStudioBranding = {
  slug: string;
  name: string;
  appName: string | null;
  brandPrimaryColor: string | null;
  brandLogoUrl: string | null;
  supportEmail: string | null;
};

/** Conservative guards: studio-controlled values are rendered, so validate shape first. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const HTTPS_URL = /^https:\/\/[^\s"'<>]+$/;
/** Matches the slug format the API issues; keeps a hostile link from probing other paths. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/i;

export function isValidStudioSlug(slug: string | null | undefined): slug is string {
  return typeof slug === "string" && SLUG.test(slug);
}

export function safeBrandColor(value: string | null | undefined): string | null {
  return typeof value === "string" && HEX_COLOR.test(value.trim()) ? value.trim() : null;
}

export function safeBrandLogo(value: string | null | undefined): string | null {
  return typeof value === "string" && HTTPS_URL.test(value.trim()) ? value.trim() : null;
}

export async function fetchPublicStudioBranding(slug: string): Promise<PublicStudioBranding> {
  return apiRequest<PublicStudioBranding>(
    `/public/studios/${encodeURIComponent(slug)}/branding`,
    { method: "GET", skipAuth: true },
  );
}
