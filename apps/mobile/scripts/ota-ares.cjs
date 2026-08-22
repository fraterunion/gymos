'use strict';

/**
 * Canonical ARES OTA workflow.
 *
 *   pnpm --filter mobile ota:ares              # verify + print plan (never publishes)
 *   pnpm --filter mobile ota:ares:publish      # verify, then publish to production-ares
 *
 * Always forces WHITELABEL_PROFILE=ares and EXPO_NO_DOTENV=1 so a developer's
 * gitignored apps/mobile/.env cannot poison the bundle. Uses the local
 * eas-cli from node_modules (pnpm exec), never a random Homebrew binary.
 *
 * Publishing is an explicit second command on purpose.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  ARES_OTA_BRANCH,
  ARES_OTA_CHANNEL,
  ARES_PRODUCTION_API_URL,
  ARES_PRODUCTION_STUDIO_SLUG,
  ARES_WHITELABEL_PROFILE,
  EAS_CLI_MIN_VERSION,
  aresReleaseChildEnv,
  easCliVersionSatisfies,
} = require('../lib/aresReleaseEnv.cjs');
const { resolveAresExpoConfig } = require('./verify-ares-env.cjs');

const mobileRoot = path.join(__dirname, '..');
const publish = process.argv.includes('--publish');

function findLocalEasBin() {
  try {
    return require.resolve('eas-cli/bin/run', { paths: [mobileRoot] });
  } catch {
    throw new Error(
      'Local eas-cli not found. Install workspace deps (pnpm install) so ' +
        '`pnpm exec eas` resolves a version satisfying eas.json (>= 18.12.1). ' +
        'Do not rely on a global Homebrew eas binary.',
    );
  }
}

function assertLocalEasVersion(easBin, env) {
  const result = spawnSync(easBin, ['--version'], {
    cwd: mobileRoot,
    env,
    encoding: 'utf8',
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    throw new Error(`Failed to read local eas --version:\n${out}`);
  }
  if (!easCliVersionSatisfies(out, EAS_CLI_MIN_VERSION)) {
    throw new Error(
      `Local eas-cli is too old: "${out}". eas.json requires >= ${EAS_CLI_MIN_VERSION}. ` +
        `Update apps/mobile/package.json eas-cli and reinstall.`,
    );
  }
  return out.split(/\s|\n/)[0] || out;
}

function main() {
  const env = aresReleaseChildEnv(process.env);

  // eslint-disable-next-line no-console -- CLI script
  console.log('— ARES OTA preflight —');
  const resolved = resolveAresExpoConfig(env);
  // eslint-disable-next-line no-console -- CLI script
  console.log(JSON.stringify(resolved, null, 2));

  const easBin = findLocalEasBin();
  const easVersion = assertLocalEasVersion(easBin, env);

  const plan = {
    action: publish ? 'PUBLISH' : 'DRY-RUN (no publish)',
    profile: ARES_WHITELABEL_PROFILE,
    channel: ARES_OTA_CHANNEL,
    branch: ARES_OTA_BRANCH,
    EXPO_PUBLIC_API_URL: ARES_PRODUCTION_API_URL,
    EXPO_PUBLIC_STUDIO_SLUG: ARES_PRODUCTION_STUDIO_SLUG,
    expoSlug: resolved.slug,
    easCli: easVersion,
    EXPO_NO_DOTENV: '1',
  };
  // eslint-disable-next-line no-console -- CLI script
  console.log('\n— plan —');
  // eslint-disable-next-line no-console -- CLI script
  console.log(JSON.stringify(plan, null, 2));

  if (resolved.slug === 'gymos-member') {
    throw new Error(
      'Refusing ARES OTA: Expo slug resolved to gymos-member (local template). ' +
        'WHITELABEL_PROFILE=ares was not applied.',
    );
  }

  if (!publish) {
    // eslint-disable-next-line no-console -- CLI script
    console.log(
      '\nDry run only. To publish:\n  pnpm --filter mobile ota:ares:publish\n',
    );
    return;
  }

  // eslint-disable-next-line no-console -- CLI script
  console.log('\n— publishing JS update to production-ares —');
  execFileSync(
    easBin,
    [
      'update',
      '--branch',
      ARES_OTA_BRANCH,
      '--platform',
      'all',
      '--message',
      'ARES production OTA',
      '--non-interactive',
    ],
    {
      cwd: mobileRoot,
      env,
      stdio: 'inherit',
    },
  );
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console -- CLI script
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
