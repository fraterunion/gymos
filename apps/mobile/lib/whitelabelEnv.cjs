'use strict';

/**
 * White-label env resolution for Expo `app.config.js`.
 *
 * Precedence (highest → lowest):
 *   1. explicit process.env already set by shell / EAS / CI
 *   2. selected profile file: env/.env.<WHITELABEL_PROFILE>
 *   3. local root `.env` — fills keys that are still unset only
 *
 * Env files MAY fill missing values. They MUST NOT overwrite existing values.
 * A developer's gitignored root `.env` must never silently replace a client
 * profile's production API URL, studio slug, or native identity.
 */

const fs = require('node:fs');
const path = require('node:path');

/** True when a key already has a non-empty value (empty string is treated as unset). */
function isEnvSet(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * Minimal .env parser (no dotenv package — works when node_modules is absent).
 * - KEY=value lines; first '=' separates key from value
 * - Ignores blank lines and lines starting with #
 * - Double/single-quoted values: strip outer quotes only
 * - Unquoted: strips trailing ` # comment` (space + hash)
 *
 * @returns {Record<string, string>}
 */
function parseEnvFileContents(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  if (typeof raw !== 'string' || raw.length === 0) return out;

  for (const line of raw.split(/\r?\n/)) {
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
    out[key] = value;
  }
  return out;
}

/**
 * Apply a .env file into `env` without overwriting keys that are already set.
 * Missing / empty keys are filled; set keys are left alone.
 *
 * @param {string} absPath
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
function applyEnvFile(absPath, env = process.env) {
  if (!fs.existsSync(absPath)) return;
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return;
  }
  const parsed = parseEnvFileContents(raw);
  for (const [key, value] of Object.entries(parsed)) {
    if (isEnvSet(env[key])) continue;
    env[key] = value;
  }
}

function isClientProfile(profile) {
  return Boolean(profile) && profile !== 'local';
}

/**
 * Load profile env, then root `.env` as a non-overriding fallback.
 * Callers must set WHITELABEL_PROFILE (and any intentional overrides) on `env` first.
 *
 * @param {string} mobileRoot absolute path to apps/mobile
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string} resolved profile name
 */
function loadProfileEnvFiles(mobileRoot, env = process.env) {
  const profile = (env.WHITELABEL_PROFILE ?? 'local').trim() || 'local';
  const tenantFile = path.join(mobileRoot, 'env', `.env.${profile}`);
  const rootEnv = path.join(mobileRoot, '.env');

  // Profile first: fills keys not already supplied by shell/EAS/CI.
  applyEnvFile(tenantFile, env);
  // Root `.env` last: local-dev convenience only — never clobber profile/EAS values.
  applyEnvFile(rootEnv, env);
  return profile;
}

/**
 * Hostnames / hosts that must never appear in a client (non-local) build's API URL.
 * Checked as substrings of the resolved URL (case-insensitive).
 */
const UNSAFE_API_HOST_MARKERS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'];

/**
 * Studio slugs that are local/QA-only and must never ship in a client profile build.
 */
const UNSAFE_STUDIO_SLUGS = new Set(['ares-qa-demo']);

function isUnsafeStudioSlug(slug) {
  const s = slug.trim().toLowerCase();
  if (UNSAFE_STUDIO_SLUGS.has(s)) return true;
  // Generic QA/demo naming: ares-qa-demo, foo-qa-demo, qa-demo, …
  if (/(?:^|[-_])qa[-_]?demo$/.test(s) || s === 'qa-demo') return true;
  return false;
}

function findUnsafeApiHostMarker(apiUrl) {
  const lower = apiUrl.toLowerCase();
  return UNSAFE_API_HOST_MARKERS.find((m) => lower.includes(m)) ?? null;
}

/**
 * Fail-fast for client white-label profiles (e.g. ares). Local profile may use localhost.
 * Throws with an explicit message — never silently substitutes values.
 *
 * @param {string} profile
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
function assertSafeResolvedEnv(profile, env = process.env) {
  if (!isClientProfile(profile)) return;

  const apiUrl = typeof env.EXPO_PUBLIC_API_URL === 'string' ? env.EXPO_PUBLIC_API_URL.trim() : '';
  const slug =
    typeof env.EXPO_PUBLIC_STUDIO_SLUG === 'string' ? env.EXPO_PUBLIC_STUDIO_SLUG.trim() : '';

  if (!apiUrl) {
    throw new Error(
      `Unsafe production mobile configuration: EXPO_PUBLIC_API_URL is missing for WHITELABEL_PROFILE=${profile}.`,
    );
  }
  if (!slug) {
    throw new Error(
      `Unsafe production mobile configuration: EXPO_PUBLIC_STUDIO_SLUG is missing for WHITELABEL_PROFILE=${profile}.`,
    );
  }

  const badHost = findUnsafeApiHostMarker(apiUrl);
  if (badHost) {
    throw new Error(
      `Unsafe production mobile configuration: EXPO_PUBLIC_API_URL resolved to localhost (${badHost}).`,
    );
  }

  if (isUnsafeStudioSlug(slug)) {
    throw new Error(
      `Unsafe production mobile configuration: EXPO_PUBLIC_STUDIO_SLUG resolved to ${slug}.`,
    );
  }
}

module.exports = {
  isEnvSet,
  parseEnvFileContents,
  applyEnvFile,
  isClientProfile,
  loadProfileEnvFiles,
  assertSafeResolvedEnv,
  isUnsafeStudioSlug,
  findUnsafeApiHostMarker,
  UNSAFE_API_HOST_MARKERS,
  UNSAFE_STUDIO_SLUGS,
};
