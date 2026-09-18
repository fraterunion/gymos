/**
 * White-label branding resolution for transactional email.
 *
 * GymOS is a platform: nothing here may mention or assume any single studio. Every
 * customer-visible string comes from the Studio row (or from a neutral platform default
 * supplied by configuration), and the precedence between the desk-era and legacy brand
 * columns matches BrandingService so an email can never disagree with the app.
 *
 * MULTI-STUDIO RULE (User.email is globally unique; a password belongs to the User, not
 * to a StudioMembership): a user may belong to several studios, so the branding of a
 * reset email is chosen deterministically:
 *   1. the studio hinted by the client (e.g. the app the user tapped "forgot password" in)
 *      — but ONLY if that user actually belongs to it, so the hint can never be used to
 *      probe membership or to brand an email for a studio the user has nothing to do with;
 *   2. otherwise the user's oldest non-deleted studio membership (ties broken by studio id)
 *      — stable across requests, so repeated resets look identical to the user;
 *   3. otherwise neutral platform branding.
 * The choice never changes WHETHER an email is sent, and the HTTP response is identical
 * in every case.
 */

export type StudioBrandingRow = {
  id: string;
  slug: string;
  name: string;
  appName: string | null;
  appDisplayName: string | null;
  brandPrimaryColor: string | null;
  primaryColor: string | null;
  brandLogoUrl: string | null;
  logoUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
};

export type PlatformEmailDefaults = {
  /** Neutral product name used when no studio context exists. */
  platformName: string;
  fromEmail: string;
  fromName: string | null;
  supportEmail: string | null;
  /** Base URL of the page that completes a reset, e.g. https://app.example.com */
  resetUrlBase: string;
};

export type ResolvedEmailBranding = {
  studioId: string | null;
  studioSlug: string | null;
  /** Public-facing display name — studio app name if branded, else studio name. */
  displayName: string;
  primaryColor: string | null;
  logoUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  from: { email: string; name: string };
};

/** Conservative hex guard so a bad studio value can never inject CSS into an email. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Only absolute http(s) images are embedded; anything else is dropped. */
const HTTP_URL = /^https?:\/\/[^\s"'<>]+$/;

export function safeHexColor(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HEX_COLOR.test(trimmed) ? trimmed : null;
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HTTP_URL.test(trimmed) ? trimmed : null;
}

export function resolveEmailBranding(
  studio: StudioBrandingRow | null,
  defaults: PlatformEmailDefaults,
): ResolvedEmailBranding {
  if (!studio) {
    return {
      studioId: null,
      studioSlug: null,
      displayName: defaults.platformName,
      primaryColor: null,
      logoUrl: null,
      supportEmail: defaults.supportEmail,
      supportPhone: null,
      from: { email: defaults.fromEmail, name: defaults.fromName ?? defaults.platformName },
    };
  }

  // Same precedence BrandingService applies: desk-era columns win over legacy brand*.
  const displayName = studio.appDisplayName ?? studio.appName ?? studio.name;
  return {
    studioId: studio.id,
    studioSlug: studio.slug,
    displayName,
    primaryColor: safeHexColor(studio.primaryColor ?? studio.brandPrimaryColor),
    logoUrl: safeHttpUrl(studio.logoUrl ?? studio.brandLogoUrl),
    supportEmail: studio.supportEmail ?? defaults.supportEmail,
    supportPhone: studio.supportPhone,
    // The envelope sender stays on the platform's verified domain; only the display name
    // is white-labelled, so studios never need their own DNS to receive resets.
    from: { email: defaults.fromEmail, name: displayName },
  };
}

/**
 * Deterministic studio choice for a user who may belong to several studios.
 * `memberships` must already exclude soft-deleted rows.
 */
export function selectBrandingStudio<T extends { studioId: string; createdAt: Date }>(
  memberships: readonly T[],
  hintedStudioId: string | null,
): string | null {
  if (memberships.length === 0) return null;
  if (hintedStudioId && memberships.some((m) => m.studioId === hintedStudioId)) {
    return hintedStudioId;
  }
  const ordered = [...memberships].sort((a, b) => {
    const byAge = a.createdAt.getTime() - b.createdAt.getTime();
    return byAge !== 0 ? byAge : a.studioId.localeCompare(b.studioId);
  });
  return ordered[0]!.studioId;
}

export function buildResetUrl(
  resetUrlBase: string,
  token: string,
  studioSlug: string | null,
): string {
  const base = resetUrlBase.replace(/\/+$/, '');
  const params = new URLSearchParams({ token });
  if (studioSlug) params.set('studio', studioSlug);
  return `${base}/reset-password?${params.toString()}`;
}
