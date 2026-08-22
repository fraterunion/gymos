'use strict';

/**
 * ARES release-contract tests + Expo preload regression coverage.
 * Run: node --test lib/aresReleaseEnv.spec.cjs
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ARES_PRODUCTION_API_URL,
  ARES_PRODUCTION_STUDIO_SLUG,
  ARES_OTA_BRANCH,
  ARES_OTA_CHANNEL,
  EAS_CLI_MIN_VERSION,
  aresReleaseChildEnv,
  assertExpectedAresProductionEnv,
  easCliVersionSatisfies,
} = require('./aresReleaseEnv.cjs');
const {
  loadProfileEnvFiles,
  assertSafeResolvedEnv,
} = require('./whitelabelEnv.cjs');

const mobileRoot = path.join(__dirname, '..');

/**
 * @param {{ profile?: string, profileEnv?: string, rootEnv?: string }} opts
 */
function makeTempMobileRoot(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gymos-ares-rel-'));
  const envDir = path.join(root, 'env');
  fs.mkdirSync(envDir);
  if (opts.profile && opts.profileEnv !== undefined) {
    fs.writeFileSync(path.join(envDir, `.env.${opts.profile}`), opts.profileEnv);
  }
  if (opts.rootEnv !== undefined) {
    fs.writeFileSync(path.join(root, '.env'), opts.rootEnv);
  }
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('1. Expo-preloaded hazardous .env blocks profile (false-green root cause)', () => {
  // Simulates Expo CLI loading apps/mobile/.env into process.env BEFORE
  // app.config.js when EXPO_NO_DOTENV is unset.
  const { root, cleanup } = makeTempMobileRoot({
    profile: 'ares',
    profileEnv:
      `EXPO_PUBLIC_API_URL=${ARES_PRODUCTION_API_URL}\nEXPO_PUBLIC_STUDIO_SLUG=${ARES_PRODUCTION_STUDIO_SLUG}\n`,
    rootEnv: 'EXPO_PUBLIC_API_URL=http://localhost:3000\nEXPO_PUBLIC_STUDIO_SLUG=ares-qa-demo\n',
  });
  try {
    /** @type {Record<string, string | undefined>} */
    const env = {
      WHITELABEL_PROFILE: 'ares',
      EXPO_PUBLIC_API_URL: 'http://localhost:3000',
      EXPO_PUBLIC_STUDIO_SLUG: 'ares-qa-demo',
    };
    loadProfileEnvFiles(root, env);
    assert.equal(env.EXPO_PUBLIC_API_URL, 'http://localhost:3000');
    assert.equal(env.EXPO_PUBLIC_STUDIO_SLUG, 'ares-qa-demo');
    assert.throws(() => assertSafeResolvedEnv('ares', env), /Unsafe production/);
  } finally {
    cleanup();
  }
});

test('2. Without preload (EXPO_NO_DOTENV semantics), ARES profile wins over hazardous root .env', () => {
  const { root, cleanup } = makeTempMobileRoot({
    profile: 'ares',
    profileEnv:
      `EXPO_PUBLIC_API_URL=${ARES_PRODUCTION_API_URL}\nEXPO_PUBLIC_STUDIO_SLUG=${ARES_PRODUCTION_STUDIO_SLUG}\n`,
    rootEnv: 'EXPO_PUBLIC_API_URL=http://localhost:3000\nEXPO_PUBLIC_STUDIO_SLUG=ares-qa-demo\n',
  });
  try {
    /** @type {Record<string, string | undefined>} */
    const env = { WHITELABEL_PROFILE: 'ares' };
    loadProfileEnvFiles(root, env);
    assertSafeResolvedEnv('ares', env);
    assertExpectedAresProductionEnv(env.EXPO_PUBLIC_API_URL, env.EXPO_PUBLIC_STUDIO_SLUG);
  } finally {
    cleanup();
  }
});

test('3. Explicit intentional release env override wins', () => {
  const { root, cleanup } = makeTempMobileRoot({
    profile: 'ares',
    profileEnv:
      'EXPO_PUBLIC_API_URL=https://from-profile.example\nEXPO_PUBLIC_STUDIO_SLUG=from-profile\n',
  });
  try {
    /** @type {Record<string, string | undefined>} */
    const env = {
      WHITELABEL_PROFILE: 'ares',
      EXPO_PUBLIC_API_URL: ARES_PRODUCTION_API_URL,
      EXPO_PUBLIC_STUDIO_SLUG: ARES_PRODUCTION_STUDIO_SLUG,
    };
    loadProfileEnvFiles(root, env);
    assertExpectedAresProductionEnv(env.EXPO_PUBLIC_API_URL, env.EXPO_PUBLIC_STUDIO_SLUG);
  } finally {
    cleanup();
  }
});

test('4. ARES expected constants match production contract', () => {
  assert.equal(ARES_PRODUCTION_API_URL, 'https://api-production-8a0e.up.railway.app');
  assert.equal(ARES_PRODUCTION_STUDIO_SLUG, 'ares-fitness');
  assert.equal(ARES_OTA_CHANNEL, 'production-ares');
  assert.equal(ARES_OTA_BRANCH, 'production-ares');
});

test('5. local profile may keep localhost', () => {
  assert.doesNotThrow(() =>
    assertSafeResolvedEnv('local', {
      EXPO_PUBLIC_API_URL: 'http://localhost:3000',
      EXPO_PUBLIC_STUDIO_SLUG: 'ares-qa-demo',
    }),
  );
});

test('6. missing ARES required config fails', () => {
  assert.throws(
    () => assertExpectedAresProductionEnv('', ARES_PRODUCTION_STUDIO_SLUG),
    /EXPO_PUBLIC_API_URL resolved to/,
  );
  assert.throws(
    () => assertExpectedAresProductionEnv(ARES_PRODUCTION_API_URL, ''),
    /EXPO_PUBLIC_STUDIO_SLUG resolved to/,
  );
});

test('7. unsafe ARES API fails safe check', () => {
  assert.throws(
    () =>
      assertSafeResolvedEnv('ares', {
        EXPO_PUBLIC_API_URL: 'http://127.0.0.1:3000',
        EXPO_PUBLIC_STUDIO_SLUG: ARES_PRODUCTION_STUDIO_SLUG,
      }),
    /127\.0\.0\.1/,
  );
});

test('8. unsafe ARES slug fails safe check', () => {
  assert.throws(
    () =>
      assertSafeResolvedEnv('ares', {
        EXPO_PUBLIC_API_URL: ARES_PRODUCTION_API_URL,
        EXPO_PUBLIC_STUDIO_SLUG: 'ares-qa-demo',
      }),
    /ares-qa-demo/,
  );
});

test('9. easCliVersionSatisfies matches eas.json floor', () => {
  assert.equal(EAS_CLI_MIN_VERSION, '18.12.1');
  assert.equal(easCliVersionSatisfies('eas-cli/18.12.1 darwin'), true);
  assert.equal(easCliVersionSatisfies('22.2.0'), true);
  assert.equal(easCliVersionSatisfies('18.12.0'), false);
  assert.equal(easCliVersionSatisfies('16.32.0'), false);
});

test('10. aresReleaseChildEnv forces profile + EXPO_NO_DOTENV', () => {
  const child = aresReleaseChildEnv({
    PATH: '/usr/bin',
    EXPO_PUBLIC_API_URL: 'http://localhost:3000',
  });
  assert.equal(child.WHITELABEL_PROFILE, 'ares');
  assert.equal(child.EXPO_NO_DOTENV, '1');
  // Intentional parent values are still visible; EXPO_NO_DOTENV only stops
  // Expo's file preload. Safety asserts still reject unsafe URLs.
  assert.equal(child.EXPO_PUBLIC_API_URL, 'http://localhost:3000');
});

test('11. ota:ares dry-run resolves plan without publishing', () => {
  const script = path.join(mobileRoot, 'scripts', 'ota-ares.cjs');
  const result = spawnSync(process.execPath, [script], {
    cwd: mobileRoot,
    env: aresReleaseChildEnv(process.env),
    encoding: 'utf8',
    timeout: 120_000,
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 0, out);
  assert.match(out, /DRY-RUN \(no publish\)/);
  assert.match(out, new RegExp(ARES_OTA_CHANNEL));
  assert.match(out, new RegExp(ARES_PRODUCTION_API_URL.replace(/\./g, '\\.')));
  assert.match(out, /ares-fitness/);
  assert.doesNotMatch(out, /publishing JS update/);
});
