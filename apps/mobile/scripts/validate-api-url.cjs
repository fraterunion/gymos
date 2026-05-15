'use strict';

/**
 * Validates the EXPO_PUBLIC_API_URL normalization logic used in lib/env.ts.
 * Run: node scripts/validate-api-url.cjs
 *
 * This mirrors the exact logic in getPublicApiUrl() so both sides stay in sync.
 */

function getPublicApiUrl(raw) {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') return '';
  return raw.trim().replace(/\/+$/, '').replace(/\/api\/v1\/?$/, '');
}

function getApiV1BaseUrl(raw) {
  const base = getPublicApiUrl(raw);
  if (!base) return '';
  return `${base}/api/v1`;
}

function buildBrandingUrl(apiUrlRaw, slug) {
  const base = getApiV1BaseUrl(apiUrlRaw);
  if (!base) return null;
  return `${base}/public/studios/${encodeURIComponent(slug)}/branding`;
}

const EXPECTED_ORIGIN = 'https://api-production-8a0e.up.railway.app';
const EXPECTED_V1     = `${EXPECTED_ORIGIN}/api/v1`;
const EXPECTED_BRANDING = `${EXPECTED_V1}/public/studios/ares-fitness/branding`;

const CASES = [
  // [input, expectedOrigin, expectedV1Base, description]
  [
    'https://api-production-8a0e.up.railway.app',
    EXPECTED_ORIGIN, EXPECTED_V1,
    'clean origin — no change needed',
  ],
  [
    'https://api-production-8a0e.up.railway.app/',
    EXPECTED_ORIGIN, EXPECTED_V1,
    'trailing slash stripped',
  ],
  [
    'https://api-production-8a0e.up.railway.app/api/v1',
    EXPECTED_ORIGIN, EXPECTED_V1,
    '/api/v1 suffix stripped (Railway env misconfigured)',
  ],
  [
    'https://api-production-8a0e.up.railway.app/api/v1/',
    EXPECTED_ORIGIN, EXPECTED_V1,
    '/api/v1/ with trailing slash stripped',
  ],
  [
    'http://localhost:4000',
    'http://localhost:4000', 'http://localhost:4000/api/v1',
    'localhost origin',
  ],
  [
    'http://localhost:4000/',
    'http://localhost:4000', 'http://localhost:4000/api/v1',
    'localhost with trailing slash',
  ],
  [
    'http://localhost:4000/api/v1',
    'http://localhost:4000', 'http://localhost:4000/api/v1',
    'localhost with /api/v1 suffix stripped',
  ],
  [
    '',
    '', '',
    'empty string → empty (env not set)',
  ],
  [
    '   ',
    '', '',
    'whitespace-only → empty',
  ],
];

let passed = 0;
let failed = 0;

for (const [input, expectedOrigin, expectedV1, desc] of CASES) {
  const gotOrigin = getPublicApiUrl(input);
  const gotV1 = getApiV1BaseUrl(input);
  const originOk = gotOrigin === expectedOrigin;
  const v1Ok = gotV1 === expectedV1;
  const ok = originOk && v1Ok;

  if (ok) {
    console.log(`  ✓  ${desc}`);
    passed++;
  } else {
    console.error(`  ✗  ${desc}`);
    if (!originOk) console.error(`       origin:  got "${gotOrigin}"  want "${expectedOrigin}"`);
    if (!v1Ok)     console.error(`       v1 base: got "${gotV1}"  want "${expectedV1}"`);
    failed++;
  }
}

console.log('');
const brandingUrl = buildBrandingUrl('https://api-production-8a0e.up.railway.app/api/v1', 'ares-fitness');
const brandingOk = brandingUrl === EXPECTED_BRANDING;
if (brandingOk) {
  console.log(`  ✓  branding URL with /api/v1 input: ${brandingUrl}`);
  passed++;
} else {
  console.error(`  ✗  branding URL mismatch`);
  console.error(`       got  "${brandingUrl}"`);
  console.error(`       want "${EXPECTED_BRANDING}"`);
  failed++;
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
