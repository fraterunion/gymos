import * as fs from 'node:fs';
import * as path from 'node:path';

import dotenv from 'dotenv';
import type { ConfigContext, ExpoConfig } from 'expo/config';

const MOBILE_ROOT = __dirname;

/** Safe defaults when `WHITELABEL_PROFILE=local` and keys are unset (internal template only). */
const LOCAL_TEMPLATE_DEFAULTS = {
  APP_DISPLAY_NAME: 'GymOS',
  APP_SCHEME: 'gymos',
  EXPO_SLUG: 'gymos-member',
  IOS_BUNDLE_IDENTIFIER: 'com.gymos.dev.member',
  ANDROID_PACKAGE: 'com.gymos.dev.member',
  APP_ICON_PATH: './assets/images/icon.png',
  APP_SPLASH_PATH: './assets/images/splash-icon.png',
  APP_ADAPTIVE_ICON_PATH: './assets/images/adaptive-icon.png',
} as const;

type AssetKey = keyof Pick<
  typeof LOCAL_TEMPLATE_DEFAULTS,
  'APP_ICON_PATH' | 'APP_SPLASH_PATH' | 'APP_ADAPTIVE_ICON_PATH'
>;

function loadProfileEnvFiles(): string {
  const profile = (process.env.WHITELABEL_PROFILE ?? 'local').trim() || 'local';
  const tenantFile = path.join(MOBILE_ROOT, 'env', `.env.${profile}`);
  const rootEnv = path.join(MOBILE_ROOT, '.env');

  if (fs.existsSync(tenantFile)) {
    dotenv.config({ path: tenantFile, override: true });
  }
  if (fs.existsSync(rootEnv)) {
    dotenv.config({ path: rootEnv, override: true });
  }
  return profile;
}

function isClientProfile(profile: string): boolean {
  return profile !== 'local';
}

function requireOrDefault(
  profile: string,
  key: keyof typeof LOCAL_TEMPLATE_DEFAULTS,
): string {
  const raw = process.env[key]?.trim();
  if (raw) return raw;
  if (!isClientProfile(profile)) {
    return LOCAL_TEMPLATE_DEFAULTS[key];
  }
  throw new Error(
    `White-label build: set ${key} in env/.env.${profile} (or environment) for WHITELABEL_PROFILE=${profile}.`,
  );
}

function resolveAssetPath(profile: string, key: AssetKey): string {
  return requireOrDefault(profile, key);
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const profile = loadProfileEnvFiles();

  const name = requireOrDefault(profile, 'APP_DISPLAY_NAME');
  const scheme = requireOrDefault(profile, 'APP_SCHEME');
  const slug = process.env.EXPO_SLUG?.trim() || requireOrDefault(profile, 'EXPO_SLUG');
  const iosBundleIdentifier = requireOrDefault(profile, 'IOS_BUNDLE_IDENTIFIER');
  const androidPackage = requireOrDefault(profile, 'ANDROID_PACKAGE');
  const icon = resolveAssetPath(profile, 'APP_ICON_PATH');
  const splashImage = resolveAssetPath(profile, 'APP_SPLASH_PATH');
  const adaptiveForeground = resolveAssetPath(profile, 'APP_ADAPTIVE_ICON_PATH');

  return {
    ...config,
    name,
    slug,
    version: '0.0.0',
    orientation: 'portrait',
    icon,
    scheme,
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    splash: {
      image: splashImage,
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
    },
    ios: {
      ...(config.ios ?? {}),
      supportsTablet: true,
      bundleIdentifier: iosBundleIdentifier,
    },
    android: {
      ...(config.android ?? {}),
      adaptiveIcon: {
        ...(config.android?.adaptiveIcon ?? {}),
        foregroundImage: adaptiveForeground,
        backgroundColor: '#ffffff',
      },
      package: androidPackage,
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
    },
    web: {
      bundler: 'metro',
      output: 'static',
      favicon: icon,
    },
    plugins: ['expo-router'],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      ...config.extra,
      whitelabelProfile: profile,
      eas: {
        projectId: "9f5697a5-b5cb-425b-850f-fa2f61068f20",
      },
    },
  };
};
