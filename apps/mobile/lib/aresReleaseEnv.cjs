'use strict';

/**
 * Canonical ARES production mobile release contract.
 *
 * Used by config:verify:ares and ota:ares so the same constants gate both
 * "is this config safe?" and "may we publish?". Do not duplicate these literals
 * in operators' heads or in ad-hoc shell one-liners.
 */

const ARES_PRODUCTION_API_URL = 'https://api-production-8a0e.up.railway.app';
const ARES_PRODUCTION_STUDIO_SLUG = 'ares-fitness';
const ARES_OTA_CHANNEL = 'production-ares';
const ARES_OTA_BRANCH = 'production-ares';
const ARES_WHITELABEL_PROFILE = 'ares';
/** Must match apps/mobile/eas.json cli.version lower bound. */
const EAS_CLI_MIN_VERSION = '18.12.1';

/**
 * Env every ARES release/verify child process must carry.
 * EXPO_NO_DOTENV=1 is required: without it Expo CLI preloads apps/mobile/.env
 * into process.env before app.config.js runs, and our loader treats those as
 * intentional shell overrides — which is how a localhost/.qa-demo .env can
 * poison a release while a plain-node verifier still reports green.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [base]
 * @returns {NodeJS.ProcessEnv}
 */
function aresReleaseChildEnv(base = process.env) {
  return {
    ...base,
    WHITELABEL_PROFILE: ARES_WHITELABEL_PROFILE,
    EXPO_NO_DOTENV: '1',
  };
}

/**
 * Exact production values for ARES. assertSafeResolvedEnv rejects unsafe hosts;
 * this additionally pins the intended production target so a "safe but wrong"
 * URL (e.g. a staging host) cannot pass a release gate.
 *
 * @param {string} apiUrl
 * @param {string} studioSlug
 */
function assertExpectedAresProductionEnv(apiUrl, studioSlug) {
  const url = (apiUrl ?? '').trim();
  const slug = (studioSlug ?? '').trim();
  if (url !== ARES_PRODUCTION_API_URL) {
    throw new Error(
      `ARES release config mismatch: EXPO_PUBLIC_API_URL resolved to "${url}" ` +
        `(expected ${ARES_PRODUCTION_API_URL}).`,
    );
  }
  if (slug !== ARES_PRODUCTION_STUDIO_SLUG) {
    throw new Error(
      `ARES release config mismatch: EXPO_PUBLIC_STUDIO_SLUG resolved to "${slug}" ` +
        `(expected ${ARES_PRODUCTION_STUDIO_SLUG}).`,
    );
  }
}

/**
 * @param {string} version raw `eas-cli/22.2.0 …` or `22.2.0`
 * @param {string} [minimum]
 * @returns {boolean}
 */
function easCliVersionSatisfies(version, minimum = EAS_CLI_MIN_VERSION) {
  const match = String(version).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [maj, min, pat] = match.slice(1).map(Number);
  const [rMaj, rMin, rPat] = minimum.split('.').map(Number);
  if (maj !== rMaj) return maj > rMaj;
  if (min !== rMin) return min > rMin;
  return pat >= rPat;
}

module.exports = {
  ARES_PRODUCTION_API_URL,
  ARES_PRODUCTION_STUDIO_SLUG,
  ARES_OTA_CHANNEL,
  ARES_OTA_BRANCH,
  ARES_WHITELABEL_PROFILE,
  EAS_CLI_MIN_VERSION,
  aresReleaseChildEnv,
  assertExpectedAresProductionEnv,
  easCliVersionSatisfies,
};
