/**
 * Prints a concise subset of the resolved Expo config (native identity + profile).
 * Run from repo root: `pnpm --filter mobile config:print`
 * Or with a profile: `WHITELABEL_PROFILE=ares pnpm --filter mobile config:print`
 */
const { execSync } = require('node:child_process');
const path = require('node:path');

const mobileRoot = path.join(__dirname, '..');
process.chdir(mobileRoot);

const json = execSync('npx expo config --json', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const cfg = JSON.parse(json);

const summary = {
  whitelabelProfile: cfg.extra?.whitelabelProfile,
  name: cfg.name,
  slug: cfg.slug,
  scheme: cfg.scheme,
  ios: { bundleIdentifier: cfg.ios?.bundleIdentifier },
  android: { package: cfg.android?.package },
  icon: cfg.icon,
  splash: cfg.splash?.image,
  androidAdaptiveForeground: cfg.android?.adaptiveIcon?.foregroundImage,
};

// eslint-disable-next-line no-console -- CLI script
console.log(JSON.stringify(summary, null, 2));
