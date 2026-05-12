/**
 * Production / CI smoke: GET /health (outside /api/v1 prefix).
 * Env: API_BASE_URL (no trailing slash required).
 * Exits 0 on success, 1 on failure. Does not log secrets.
 */

function baseUrl() {
  const raw = process.env.API_BASE_URL;
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    console.error('smoke-health: API_BASE_URL is required (e.g. https://api.example.com)');
    process.exit(1);
  }
  return raw.replace(/\/$/, '');
}

async function main() {
  const base = baseUrl();
  const url = `${base}/health`;
  let res;
  try {
    res = await fetch(url, { method: 'GET' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`smoke-health: request failed (${url}): ${msg}`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`smoke-health: HTTP ${res.status} for ${url}`);
    process.exit(1);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    console.error('smoke-health: response is not valid JSON');
    process.exit(1);
  }

  if (data?.status !== 'ok') {
    console.error('smoke-health: expected body { "status": "ok" }');
    process.exit(1);
  }

  console.log('smoke-health: ok');
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`smoke-health: ${msg}`);
  process.exit(1);
});
