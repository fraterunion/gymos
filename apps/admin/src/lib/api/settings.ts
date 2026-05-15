import { apiRequest } from "@/lib/api/client";

export type StudioSettingsGeneral = {
  name: string;
  slug: string;
  timezone: string;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
  instagramHandle: string | null;
  address: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
};

export type StudioSettingsBranding = {
  logoUrl: string | null;
  coverImageUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  legacyBrandLogoUrl: string | null;
  legacyBrandPrimaryColor: string | null;
  legacyBrandSecondaryColor: string | null;
  brandIconUrl: string | null;
  brandSplashUrl: string | null;
  effectivePrimaryColor: string;
  effectiveAccentColor: string;
  effectiveLogoUrl: string | null;
};

export type StudioSettingsBookingRules = {
  allowWaitlist: boolean;
  autoConfirmWaitlist: boolean;
  cancellationWindowHours: number;
  lateCancelPenaltyEnabled: boolean;
  checkInWindowMinutes: number;
};

export type StudioSettingsMobile = {
  appDisplayName: string | null;
  appScheme: string | null;
  expoSlug: string | null;
  iosBundleIdentifier: string | null;
  androidPackage: string | null;
};

export type StudioSettingsDto = {
  general: StudioSettingsGeneral;
  branding: StudioSettingsBranding;
  bookingRules: StudioSettingsBookingRules;
  /** Present only for FraterUnion platform operators (see API redaction). */
  mobile?: StudioSettingsMobile;
  mobileWhiteLabelStatus?: "ready" | "incomplete";
  storeLinks: { appStoreUrl: string | null; playStoreUrl: string | null };
  updatedAt: string;
};

export type PatchGeneralBody = Partial<{
  name: string;
  timezone: string;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
  instagramHandle: string | null;
  address: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
}>;

export type PatchBrandingBody = Partial<{
  logoUrl: string | null;
  coverImageUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}>;

export type PatchBookingRulesBody = Partial<{
  allowWaitlist: boolean;
  autoConfirmWaitlist: boolean;
  cancellationWindowHours: number;
  lateCancelPenaltyEnabled: boolean;
  checkInWindowMinutes: number;
}>;

export type PatchMobileBody = Partial<{
  appDisplayName: string | null;
  appScheme: string | null;
  expoSlug: string | null;
  iosBundleIdentifier: string | null;
  androidPackage: string | null;
}>;

/** Full flat body for PATCH mobile-config (all keys sent; empty strings become null). */
export type MobileConfigFlatPayload = {
  appDisplayName: string | null;
  appScheme: string | null;
  expoSlug: string | null;
  iosBundleIdentifier: string | null;
  androidPackage: string | null;
};

export function buildMobileConfigFlatPayload(fields: {
  appDisplayName: string;
  appScheme: string;
  expoSlug: string;
  iosBundleIdentifier: string;
  androidPackage: string;
}): MobileConfigFlatPayload {
  return {
    appDisplayName: fields.appDisplayName.trim() || null,
    appScheme: fields.appScheme.trim() || null,
    expoSlug: fields.expoSlug.trim() || null,
    iosBundleIdentifier: fields.iosBundleIdentifier.trim() || null,
    androidPackage: fields.androidPackage.trim() || null,
  };
}

export async function fetchStudioSettings(studioId: string): Promise<StudioSettingsDto> {
  return apiRequest<StudioSettingsDto>(`/studios/${studioId}/settings`, { method: "GET" });
}

export async function updateGeneralSettings(
  studioId: string,
  body: PatchGeneralBody,
): Promise<StudioSettingsDto> {
  return apiRequest<StudioSettingsDto>(`/studios/${studioId}/settings/general`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function updateBrandingSettings(
  studioId: string,
  body: PatchBrandingBody,
): Promise<StudioSettingsDto> {
  return apiRequest<StudioSettingsDto>(`/studios/${studioId}/settings/branding`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function updateBookingRules(
  studioId: string,
  body: PatchBookingRulesBody,
): Promise<StudioSettingsDto> {
  return apiRequest<StudioSettingsDto>(`/studios/${studioId}/settings/booking-rules`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function updateMobileConfig(
  studioId: string,
  body: PatchMobileBody | MobileConfigFlatPayload,
): Promise<StudioSettingsDto> {
  return apiRequest<StudioSettingsDto>(`/studios/${studioId}/settings/mobile-config`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}
