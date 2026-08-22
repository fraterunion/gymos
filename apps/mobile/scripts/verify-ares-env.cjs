'use strict';

/**
 * CI / pre-OTA smoke: resolve the ares white-label profile and assert production-safe env.
 * Loads the same path as app.config.js (explicit env > profile > root .env fill-only).
 *
 * Run: pnpm --filter mobile config:verify:ares
 * Or:  WHITELABEL_PROFILE=ares node scripts/verify-ares-env.cjs
 */

const path = require('node:path');
const {
  loadProfileEnvFiles,
  assertSafeResolvedEnv,
} = require('../lib/whitelabelEnv.cjs');

const mobileRoot = path.join(__dirname, '..');
process.env.WHITELABEL_PROFILE = (process.env.WHITELABEL_PROFILE ?? 'ares').trim() || 'ares';

const profile = loadProfileEnvFiles(mobileRoot, process.env);
assertSafeResolvedEnv(profile, process.env);

const apiUrl = (process.env.EXPO_PUBLIC_API_URL ?? '').trim();
const slug = (process.env.EXPO_PUBLIC_STUDIO_SLUG ?? '').trim();

const summary = {
  profile,
  EXPO_PUBLIC_API_URL: apiUrl,
  EXPO_PUBLIC_STUDIO_SLUG: slug,
  ok: true,
};

// eslint-disable-next-line no-console -- CLI script
console.log(JSON.stringify(summary, null, 2));
