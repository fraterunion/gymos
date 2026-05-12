/**
 * Optional smoke: login then GET /auth/me.
 * Env: API_BASE_URL, SMOKE_EMAIL, SMOKE_PASSWORD (never commit real values).
 * Exits 0 on success, 1 on failure. Does not log tokens, passwords, or response bodies.
 */

function baseUrl() {
  const raw = process.env.API_BASE_URL;
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    console.error('smoke-auth: API_BASE_URL is required');
    process.exit(1);
  }
  return raw.replace(/\/$/, '');
}

async function main() {
  const base = baseUrl();
  const email = process.env.SMOKE_EMAIL;
  const password = process.env.SMOKE_PASSWORD;
  if (!email || !password) {
    console.error('smoke-auth: SMOKE_EMAIL and SMOKE_PASSWORD are required');
    process.exit(1);
  }

  const loginUrl = `${base}/api/v1/auth/login`;
  let loginRes;
  try {
    loginRes = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`smoke-auth: login request failed: ${msg}`);
    process.exit(1);
  }

  if (!loginRes.ok) {
    console.error(`smoke-auth: login HTTP ${loginRes.status}`);
    process.exit(1);
  }

  let loginBody;
  try {
    loginBody = await loginRes.json();
  } catch {
    console.error('smoke-auth: login response is not valid JSON');
    process.exit(1);
  }

  const accessToken = loginBody?.accessToken;
  if (typeof accessToken !== 'string' || !accessToken) {
    console.error('smoke-auth: login response missing accessToken');
    process.exit(1);
  }

  const meUrl = `${base}/api/v1/auth/me`;
  let meRes;
  try {
    meRes = await fetch(meUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`smoke-auth: me request failed: ${msg}`);
    process.exit(1);
  }

  if (!meRes.ok) {
    console.error(`smoke-auth: me HTTP ${meRes.status}`);
    process.exit(1);
  }

  console.log('smoke-auth: ok');
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`smoke-auth: ${msg}`);
  process.exit(1);
});
