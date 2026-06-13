const fs = require('node:fs');
const path = require('node:path');

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
  APP_VERSION: '1.0.0',
  IOS_BUILD_NUMBER: '2',
  // Native launcher name (iOS home screen / Android drawer). Intentionally short.
  APP_LAUNCHER_NAME: 'ARES',
  APP_ICON_PATH: './assets/branding/ares/icon.png',
  APP_SPLASH_PATH: './assets/branding/ares/splash-logo.png',
  APP_ADAPTIVE_ICON_PATH: './assets/branding/ares/adaptive-icon.png',
  APP_SPLASH_BG_COLOR: '#000000',
  APP_ADAPTIVE_ICON_BG_COLOR: '#000000',
};

/**
 * Minimal .env parser (no dotenv package — works when node_modules is absent, e.g. EAS temp workspace).
 * - KEY=value lines; first '=' separates key from value
 * - Ignores blank lines and lines starting with #
 * - Double/single-quoted values: strip outer quotes only
 * - Unquoted: strips trailing ` # comment` (space + hash)
 * Matches prior dotenv.config({ override: true }): file entries always set process.env[key].
 */
function applyEnvFile(absPath) {
  if (!fs.existsSync(absPath)) return;
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return;
  }
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = t.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      const hashIdx = value.search(/\s+#/);
      if (hashIdx !== -1) {
        value = value.slice(0, hashIdx).trimEnd();
      }
    }
    process.env[key] = value;
  }
}

function loadProfileEnvFiles() {
  const profile = (process.env.WHITELABEL_PROFILE ?? 'local').trim() || 'local';
  const tenantFile = path.join(MOBILE_ROOT, 'env', `.env.${profile}`);
  const rootEnv = path.join(MOBILE_ROOT, '.env');

  applyEnvFile(tenantFile);
  applyEnvFile(rootEnv);
  return profile;
}

function isClientProfile(profile) {
  return profile !== 'local';
}

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
  const profile = loadProfileEnvFiles();

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
      supportsTablet: true,
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
          cameraPermission: 'Scan member QR codes to check in attendees.',
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
