/**
 * ARES PR #5 read-only deployed-api smoke (GitHub CI only on feature branch).
 * The URL and origins are hard-coded to non-production rehearsal assets.
 * No account credentials, database mutations, Stripe API writes, emails,
 * or membership price change endpoints are invoked.
 */
const api = 'https://api-rehearsal-release-rehearsal.up.railway.app';
const allowedOrigins = [
  'https://gymos-admin-f18ec42lj-fraterunionco-7839s-projects.vercel.app',
  'https://gymos-admin-git-feat-ares-o-6ea9b9-fraterunionco-7839s-projects.vercel.app',
];

async function get(path, init = {}) {
  const response = await fetch(new URL(path, api), {
    ...init,
    signal: AbortSignal.timeout(20000),
    redirect: 'manual',
  });
  return response;
}

function assert(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`PASS: ${label}`);
}

async function main() {
  const health = await get('/health');
  assert(health.status === 200, 'Rehearsal API /health returns 200');
  const json = await health.json();
  assert(json?.status === 'ok', 'Rehearsal API reports healthy');

  // Never call authentication with credentials: verify only that protected
  // routes reject a caller with no JWT.
  const unauthenticated = await get('/api/v1/auth/me');
  assert(unauthenticated.status === 401, 'Missing auth token is rejected (401)');
  const campaigns = await get('/api/v1/studios/00000000-0000-4000-8000-000000000000/communications/campaigns');
  assert(campaigns.status === 401, 'Campaign recipient data requires authentication');

  for (const origin of allowedOrigins) {
    const res = await get('/api/v1/auth/login', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization',
      },
    });
    assert(res.status === 204 || res.status === 200, 'Login CORS preflight accepted');
    assert(res.headers.get('access-control-allow-origin') === origin,
      'CORS allows exact protected rehearsal admin origin');
    assert((res.headers.get('access-control-allow-methods') ?? '').includes('POST'),
      'CORS allows admin login POST');
  }
  console.log('PASS: ARES PR5 rehearsal public smoke; read-only, no production changes');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
