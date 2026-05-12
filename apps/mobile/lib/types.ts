export type PublicBranding = {
  slug: string;
  name: string;
  timezone: string;
  appName: string | null;
  brandPrimaryColor: string | null;
  brandSecondaryColor: string | null;
  brandLogoUrl: string | null;
  brandIconUrl: string | null;
  brandSplashUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  iosBundleId: string | null;
  androidPackageName: string | null;
  appStoreUrl: string | null;
  playStoreUrl: string | null;
};

export type AuthUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuthBundle = {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
};
