'use strict';

/**
 * Deterministic tests for white-label env precedence + production fail-fast.
 * Run: node --test lib/whitelabelEnv.spec.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseEnvFileContents,
  applyEnvFile,
  loadProfileEnvFiles,
  assertSafeResolvedEnv,
  isClientProfile,
  isEnvSet,
} = require('./whitelabelEnv.cjs');

/**
 * @param {{ profile?: string, profileEnv?: string, rootEnv?: string }} opts
 * @returns {{ root: string, cleanup: () => void }}
 */
function makeTempMobileRoot(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gymos-wl-env-'));
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

test('parseEnvFileContents handles quotes, comments, and blank lines', () => {
  const parsed = parseEnvFileContents(`
# comment
FOO=bar
QUOTED="hello world"
SINGLE='x=y'
WITH_COMMENT=value # trailing comment
EMPTY=
INVALID LINE
=nope
_OK=1
`);
  assert.equal(parsed.FOO, 'bar');
  assert.equal(parsed.QUOTED, 'hello world');
  assert.equal(parsed.SINGLE, 'x=y');
  assert.equal(parsed.WITH_COMMENT, 'value');
  assert.equal(parsed.EMPTY, '');
  assert.equal(parsed._OK, '1');
  assert.equal(parsed['INVALID LINE'], undefined);
});

test('isEnvSet treats undefined, null, and whitespace-only as unset', () => {
  assert.equal(isEnvSet(undefined), false);
  assert.equal(isEnvSet(null), false);
  assert.equal(isEnvSet(''), false);
  assert.equal(isEnvSet('   '), false);
  assert.equal(isEnvSet('x'), true);
});

test('1. profile env set, root .env also set → profile wins', () => {
  const { root, cleanup } = makeTempMobileRoot({
    profile: 'ares',
    profileEnv: 'EXPO_PUBLIC_API_URL=https://api.prod.example\nEXPO_PUBLIC_STUDIO_SLUG=ares-fitness\n',
    rootEnv: 'EXPO_PUBLIC_API_URL=http://localhost:3000\nEXPO_PUBLIC_STUDIO_SLUG=ares-qa-demo\n',
  });
  try {
    /** @type {Record<string, string | undefined>} */
    const env = { WHITELABEL_PROFILE: 'ares' };
    loadProfileEnvFiles(root, env);
    assert.equal(env.EXPO_PUBLIC_API_URL, 'https://api.prod.example');
    assert.equal(env.EXPO_PUBLIC_STUDIO_SLUG, 'ares-fitness');
  } finally {
    cleanup();
  }
});

test('2. explicit process.env set, profile env set → explicit wins', () => {
  const { root, cleanup } = makeTempMobileRoot({
    profile: 'ares',
    profileEnv: 'EXPO_PUBLIC_API_URL=https://from-profile.example\nEXPO_PUBLIC_STUDIO_SLUG=from-profile\n',
    rootEnv: 'EXPO_PUBLIC_API_URL=http://localhost:3000\n',
  });
  try {
    /** @type {Record<string, string | undefined>} */
    const env = {
      WHITELABEL_PROFILE: 'ares',
      EXPO_PUBLIC_API_URL: 'https://from-shell.example',
      EXPO_PUBLIC_STUDIO_SLUG: 'from-shell',
    };
    loadProfileEnvFiles(root, env);
    assert.equal(env.EXPO_PUBLIC_API_URL, 'https://from-shell.example');
    assert.equal(env.EXPO_PUBLIC_STUDIO_SLUG, 'from-shell');
  } finally {
    cleanup();
  }
});

test('3. key absent from process + profile → root .env may fill it', () => {
  const { root, cleanup } = makeTempMobileRoot({
    profile: 'local',
    profileEnv: 'APP_DISPLAY_NAME=FromProfile\n',
    rootEnv: 'EXPO_PUBLIC_API_URL=http://localhost:3000\nEXPO_PUBLIC_STUDIO_SLUG=local-studio\n',
  });
  try {
    /** @type {Record<string, string | undefined>} */
    const env = { WHITELABEL_PROFILE: 'local' };
    loadProfileEnvFiles(root, env);
    assert.equal(env.APP_DISPLAY_NAME, 'FromProfile');
    assert.equal(env.EXPO_PUBLIC_API_URL, 'http://localhost:3000');
    assert.equal(env.EXPO_PUBLIC_STUDIO_SLUG, 'local-studio');
  } finally {
    cleanup();
  }
});

test('4. root .env has localhost but production profile has valid API → production API remains', () => {
  const { root, cleanup } = makeTempMobileRoot({
    profile: 'ares',
    profileEnv:
      'EXPO_PUBLIC_API_URL=https://api-production-8a0e.up.railway.app\nEXPO_PUBLIC_STUDIO_SLUG=ares-fitness\n',
    rootEnv: 'EXPO_PUBLIC_API_URL=http://localhost:3000\nEXPO_PUBLIC_STUDIO_SLUG=ares-qa-demo\n',
  });
  try {
    /** @type {Record<string, string | undefined>} */
    const env = { WHITELABEL_PROFILE: 'ares' };
    loadProfileEnvFiles(root, env);
    assertSafeResolvedEnv('ares', env);
    assert.equal(env.EXPO_PUBLIC_API_URL, 'https://api-production-8a0e.up.railway.app');
    assert.equal(env.EXPO_PUBLIC_STUDIO_SLUG, 'ares-fitness');
  } finally {
    cleanup();
  }
});

test('5. production-ares / client profile resolves localhost → fails', () => {
  assert.throws(
    () =>
      assertSafeResolvedEnv('ares', {
        EXPO_PUBLIC_API_URL: 'http://localhost:3000',
        EXPO_PUBLIC_STUDIO_SLUG: 'ares-fitness',
      }),
    /Unsafe production mobile configuration: EXPO_PUBLIC_API_URL resolved to localhost/,
  );
  assert.throws(
    () =>
      assertSafeResolvedEnv('ares', {
        EXPO_PUBLIC_API_URL: 'http://127.0.0.1:4000',
        EXPO_PUBLIC_STUDIO_SLUG: 'ares-fitness',
      }),
    /resolved to localhost \(127\.0\.0\.1\)/,
  );
});

test('6. production-ares resolves ares-qa-demo → fails', () => {
  assert.throws(
    () =>
      assertSafeResolvedEnv('ares', {
        EXPO_PUBLIC_API_URL: 'https://api-production-8a0e.up.railway.app',
        EXPO_PUBLIC_STUDIO_SLUG: 'ares-qa-demo',
      }),
    /Unsafe production mobile configuration: EXPO_PUBLIC_STUDIO_SLUG resolved to ares-qa-demo/,
  );
});

test('7. development/local profile can still use localhost when intentionally allowed', () => {
  assert.equal(isClientProfile('local'), false);
  assert.doesNotThrow(() =>
    assertSafeResolvedEnv('local', {
      EXPO_PUBLIC_API_URL: 'http://localhost:3000',
      EXPO_PUBLIC_STUDIO_SLUG: 'ares-qa-demo',
    }),
  );
});

test('8. no profile selected → defaults to local and remains usable', () => {
  const { root, cleanup } = makeTempMobileRoot({
    rootEnv: 'EXPO_PUBLIC_API_URL=http://localhost:3000\nEXPO_PUBLIC_STUDIO_SLUG=dev-slug\n',
  });
  try {
    /** @type {Record<string, string | undefined>} */
    const env = {};
    const profile = loadProfileEnvFiles(root, env);
    assert.equal(profile, 'local');
    assert.equal(env.EXPO_PUBLIC_API_URL, 'http://localhost:3000');
    assert.doesNotThrow(() => assertSafeResolvedEnv(profile, env));
  } finally {
    cleanup();
  }
});

test('9. unrelated env keys are not deleted', () => {
  const { root, cleanup } = makeTempMobileRoot({
    profile: 'ares',
    profileEnv: 'EXPO_PUBLIC_API_URL=https://api.prod.example\nEXPO_PUBLIC_STUDIO_SLUG=ares-fitness\n',
    rootEnv: 'EXPO_PUBLIC_API_URL=http://localhost:3000\n',
  });
  try {
    /** @type {Record<string, string | undefined>} */
    const env = {
      WHITELABEL_PROFILE: 'ares',
      PATH: '/usr/bin',
      CUSTOM_KEEP_ME: 'still-here',
      EMPTY_FILLABLE: '',
    };
    loadProfileEnvFiles(root, env);
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.CUSTOM_KEEP_ME, 'still-here');
    assert.equal(env.EXPO_PUBLIC_API_URL, 'https://api.prod.example');
  } finally {
    cleanup();
  }
});

test('10. dotenv parsing still handles quoted values/comments correctly via applyEnvFile', () => {
  const { root, cleanup } = makeTempMobileRoot({
    rootEnv: 'NAME="Ares Training Club"\nSCHEME=aresfitness # scheme\n',
  });
  try {
    /** @type {Record<string, string | undefined>} */
    const env = {};
    applyEnvFile(path.join(root, '.env'), env);
    assert.equal(env.NAME, 'Ares Training Club');
    assert.equal(env.SCHEME, 'aresfitness');
  } finally {
    cleanup();
  }
});

test('empty explicit env is treated as unset so profile can fill it', () => {
  const { root, cleanup } = makeTempMobileRoot({
    profile: 'ares',
    profileEnv: 'EXPO_PUBLIC_API_URL=https://from-profile.example\nEXPO_PUBLIC_STUDIO_SLUG=ares-fitness\n',
  });
  try {
    /** @type {Record<string, string | undefined>} */
    const env = {
      WHITELABEL_PROFILE: 'ares',
      EXPO_PUBLIC_API_URL: '',
    };
    loadProfileEnvFiles(root, env);
    assert.equal(env.EXPO_PUBLIC_API_URL, 'https://from-profile.example');
  } finally {
    cleanup();
  }
});

test('client profile missing API URL fails fast', () => {
  assert.throws(
    () =>
      assertSafeResolvedEnv('ares', {
        EXPO_PUBLIC_STUDIO_SLUG: 'ares-fitness',
      }),
    /EXPO_PUBLIC_API_URL is missing/,
  );
});

test('client profile missing studio slug fails fast', () => {
  assert.throws(
    () =>
      assertSafeResolvedEnv('ares', {
        EXPO_PUBLIC_API_URL: 'https://api.example.com',
      }),
    /EXPO_PUBLIC_STUDIO_SLUG is missing/,
  );
});
