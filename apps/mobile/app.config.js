const {
  loadProfileEnvFiles,
  assertSafeResolvedEnv,
  isClientProfile,
} = require('./lib/whitelabelEnv.cjs');

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
};

/** Checked-in Ares Training Club brand assets (WHITELABEL_PROFILE=ares). */
const ARES_PROFILE_DEFAULTS = {
  APP_VERSION: '1.1',
  IOS_BUILD_NUMBER: '8',
  // Native launcher name (iOS home screen / Android drawer). Intentionally short.
  APP_LAUNCHER_NAME: 'ARES',
  APP_ICON_PATH: './assets/branding/ares/icon.png',
  APP_SPLASH_PATH: './assets/branding/ares/splash-screen.png',
  APP_ADAPTIVE_ICON_PATH: './assets/branding/ares/adaptive-icon.png',
  APP_SPLASH_BG_COLOR: '#000000',
  APP_ADAPTIVE_ICON_BG_COLOR: '#000000',
};

function profileDefaults(profile) {
  if (profile === 'ares') return { ...ARES_PROFILE_DEFAULTS };
  if (!isClientProfile(profile)) return { ...LOCAL_TEMPLATE_DEFAULTS };
  return {};
}

function requireOrDefault(profile, key) {
  const raw = process.env[key]?.trim();
  if (raw) return raw;
  const defaults = profileDefaults(profile);
  if (key in defaults) return defaults[key];
  if (!isClientProfile(profile)) {
    return LOCAL_TEMPLATE_DEFAULTS[key];
  }
  throw new Error(
    `White-label build: set ${key} in env/.env.${profile} (or environment) for WHITELABEL_PROFILE=${profile}.`,
  );
}

function resolveAssetPath(profile, key) {
  return requireOrDefault(profile, key);
}

module.exports = ({ config }) => {
  // Precedence: explicit process.env > env/.env.<profile> > root .env (fill-only).
  // See lib/whitelabelEnv.cjs — root `.env` must never clobber a client profile.
  const profile = loadProfileEnvFiles(MOBILE_ROOT, process.env);
  assertSafeResolvedEnv(profile, process.env);

  // APP_LAUNCHER_NAME → native iOS CFBundleDisplayName / Android android:label (home screen).
  // APP_DISPLAY_NAME  → in-app branding / store listing copy (Ares Training Club).
  // Falls back to APP_DISPLAY_NAME if APP_LAUNCHER_NAME is not set (non-Ares profiles).
  const launcherName =
    process.env.APP_LAUNCHER_NAME?.trim() ||
    profileDefaults(profile).APP_LAUNCHER_NAME ||
    requireOrDefault(profile, 'APP_DISPLAY_NAME');
  const name = launcherName;
  const scheme = requireOrDefault(profile, 'APP_SCHEME');
  const slug = process.env.EXPO_SLUG?.trim() || requireOrDefault(profile, 'EXPO_SLUG');
  const iosBundleIdentifier = requireOrDefault(profile, 'IOS_BUNDLE_IDENTIFIER');
  const androidPackage = requireOrDefault(profile, 'ANDROID_PACKAGE');
  const icon = resolveAssetPath(profile, 'APP_ICON_PATH');
  const splashImage = resolveAssetPath(profile, 'APP_SPLASH_PATH');
  const adaptiveForeground = resolveAssetPath(profile, 'APP_ADAPTIVE_ICON_PATH');
  const splashBackgroundColor =
    process.env.APP_SPLASH_BG_COLOR?.trim() ||
    profileDefaults(profile).APP_SPLASH_BG_COLOR ||
    '#ffffff';
  const adaptiveIconBackgroundColor =
    process.env.APP_ADAPTIVE_ICON_BG_COLOR?.trim() ||
    profileDefaults(profile).APP_ADAPTIVE_ICON_BG_COLOR ||
    splashBackgroundColor;
  const version =
    process.env.APP_VERSION?.trim() || profileDefaults(profile).APP_VERSION || '0.0.0';
  const iosBuildNumber =
    process.env.IOS_BUILD_NUMBER?.trim() || profileDefaults(profile).IOS_BUILD_NUMBER;

  return {
    ...config,
    name,
    slug,
    version,
    orientation: 'portrait',
    icon,
    scheme,
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    splash: {
      image: splashImage,
      resizeMode: 'contain',
      backgroundColor: splashBackgroundColor,
    },
    ios: {
      ...(config.ios ?? {}),
      // ARES is iPhone-only — excludes iPad from App Store device family.
      supportsTablet: profile !== 'ares',
      bundleIdentifier: iosBundleIdentifier,
      ...(iosBuildNumber ? { buildNumber: iosBuildNumber } : {}),
    },
    android: {
      ...(config.android ?? {}),
      adaptiveIcon: {
        ...(config.android?.adaptiveIcon ?? {}),
        foregroundImage: adaptiveForeground,
        backgroundColor: adaptiveIconBackgroundColor,
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
    plugins: [
      'expo-router',
      [
        '@stripe/stripe-react-native',
        {
          merchantIdentifier: 'merchant.com.gymos.ares',
          enableGooglePay: true,
        },
      ],
      [
        'expo-camera',
        {
          // Staff Mode: scan member booking QR codes at the front desk.
          cameraPermission: 'Escanea códigos QR de miembros para registrar su check-in.',
        },
      ],
    ],
    updates: {
      url: 'https://u.expo.dev/9f5697a5-b5cb-425b-850f-fa2f61068f20',
    },
    runtimeVersion: {
      policy: 'appVersion',
    },
    experiments: {
      typedRoutes: true,
    },
    extra: {
      ...config.extra,
      whitelabelProfile: profile,
      eas: {
        projectId: '9f5697a5-b5cb-425b-850f-fa2f61068f20',
      },
    },
  };
};
