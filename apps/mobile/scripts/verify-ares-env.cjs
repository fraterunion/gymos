'use strict';

/**
 * Resolve ARES config through the SAME pathway Expo uses for export / EAS update:
 *   EXPO_NO_DOTENV=1 + WHITELABEL_PROFILE=ares → `expo config --json` → app.config.js
 *
 * Do not reimplement dotenv here. A plain-node load of whitelabelEnv.cjs alone can
 * disagree with Expo when Expo has preloaded apps/mobile/.env.
 *
 * Run: pnpm --filter mobile config:verify:ares
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const {
  ARES_PRODUCTION_API_URL,
  ARES_PRODUCTION_STUDIO_SLUG,
  ARES_WHITELABEL_PROFILE,
  aresReleaseChildEnv,
  assertExpectedAresProductionEnv,
} = require('../lib/aresReleaseEnv.cjs');

const mobileRoot = path.join(__dirname, '..');

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [baseEnv]
 * @returns {{
 *   profile: string,
 *   EXPO_PUBLIC_API_URL: string,
 *   EXPO_PUBLIC_STUDIO_SLUG: string,
 *   slug: string,
 *   runtimeVersion: string | { policy: string } | undefined,
 *   ok: true,
 * }}
 */
function resolveAresExpoConfig(baseEnv = process.env) {
  const childEnv = aresReleaseChildEnv(baseEnv);
  // Resolve through Node module paths so pnpm hoisting cannot point us at a
  // missing apps/mobile/node_modules/expo while the workspace root has it.
  const expoCli = require.resolve('expo/bin/cli', { paths: [mobileRoot] });

  let raw;
  try {
    raw = execFileSync(process.execPath, [expoCli, 'config', '--json'], {
      cwd: mobileRoot,
      env: childEnv,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : '';
    const stdout = err && typeof err === 'object' && 'stdout' in err ? String(err.stdout) : '';
    const detail = (stderr || stdout || (err instanceof Error ? err.message : String(err))).trim();
    throw new Error(
      `ARES config verification failed while running expo config (EXPO_NO_DOTENV=1).\n${detail}`,
    );
  }

  // expo config --json may print non-JSON diagnostics before the object.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error(`ARES config verification failed: expo config did not return JSON.\n${raw}`);
  }

  /** @type {any} */
  const cfg = JSON.parse(raw.slice(start, end + 1));
  const profile = String(cfg.extra?.whitelabelProfile ?? '').trim();
  const apiUrl = String(cfg.extra?.expoPublicApiUrl ?? '').trim();
  const studioSlug = String(cfg.extra?.expoPublicStudioSlug ?? '').trim();

  if (profile !== ARES_WHITELABEL_PROFILE) {
    throw new Error(
      `ARES config verification failed: whitelabelProfile resolved to "${profile}" ` +
        `(expected ${ARES_WHITELABEL_PROFILE}).`,
    );
  }

  assertExpectedAresProductionEnv(apiUrl, studioSlug);

  return {
    profile,
    EXPO_PUBLIC_API_URL: apiUrl,
    EXPO_PUBLIC_STUDIO_SLUG: studioSlug,
    slug: String(cfg.slug ?? ''),
    runtimeVersion: cfg.runtimeVersion,
    ok: true,
  };
}

function main() {
  const summary = resolveAresExpoConfig(process.env);
  // eslint-disable-next-line no-console -- CLI script
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // eslint-disable-next-line no-console -- CLI script
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

module.exports = {
  resolveAresExpoConfig,
  ARES_PRODUCTION_API_URL,
  ARES_PRODUCTION_STUDIO_SLUG,
};
