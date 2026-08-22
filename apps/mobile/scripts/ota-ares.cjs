'use strict';

/**
 * Canonical ARES OTA workflow.
 *
 *   pnpm --filter mobile ota:ares              # dry-run plan only (no Expo/EAS/network)
 *   pnpm --filter mobile ota:ares:publish      # Expo verify, then publish to production-ares
 *
 * Always forces WHITELABEL_PROFILE=ares and EXPO_NO_DOTENV=1 on the publish path
 * so a developer's gitignored apps/mobile/.env cannot poison the bundle.
 * Uses the local eas-cli from node_modules (pnpm exec), never a random Homebrew binary.
 *
 * Dry-run builds the plan from lib/aresReleaseEnv.cjs (shared contract). Live Expo
 * resolution is proven by `pnpm --filter mobile config:verify:ares`, not by dry-run.
 * Publish still runs Expo verify before any EAS network call.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  ARES_OTA_BRANCH,
  ARES_WHITELABEL_PROFILE,
  EAS_CLI_MIN_VERSION,
  aresReleaseChildEnv,
  buildAresOtaPlan,
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

  if (!publish) {
    const plan = buildAresOtaPlan({ publish: false });
    // eslint-disable-next-line no-console -- CLI script
    console.log('— ARES OTA dry-run (no Expo / no EAS / no publish) —');
    // eslint-disable-next-line no-console -- CLI script
    console.log(JSON.stringify(plan, null, 2));
    // eslint-disable-next-line no-console -- CLI script
    console.log(
      '\nProve live Expo resolution separately:\n' +
        '  pnpm --filter mobile config:verify:ares\n' +
        '\nTo publish:\n' +
        '  pnpm --filter mobile ota:ares:publish\n',
    );
    return;
  }

  // eslint-disable-next-line no-console -- CLI script
  console.log('— ARES OTA publish preflight (Expo config) —');
  const resolved = resolveAresExpoConfig(env);
  // eslint-disable-next-line no-console -- CLI script
  console.log(JSON.stringify(resolved, null, 2));

  if (resolved.slug === 'gymos-member') {
    throw new Error(
      'Refusing ARES OTA: Expo slug resolved to gymos-member (local template). ' +
        `WHITELABEL_PROFILE=${ARES_WHITELABEL_PROFILE} was not applied.`,
    );
  }

  const easBin = findLocalEasBin();
  const easVersion = assertLocalEasVersion(easBin, env);
  const plan = buildAresOtaPlan({
    publish: true,
    expoSlug: resolved.slug,
    easCliVersion: easVersion,
  });
  // eslint-disable-next-line no-console -- CLI script
  console.log('\n— plan —');
  // eslint-disable-next-line no-console -- CLI script
  console.log(JSON.stringify(plan, null, 2));

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
