/**
 * Verifies Stripe **test-mode** billing env is present for pilot lanes.
 * Does not print secret values — only OK / missing / wrong prefix.
 *
 * Required: STRIPE_SECRET_KEY (must start with sk_test_), STRIPE_WEBHOOK_SECRET (whsec_),
 * STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL, STRIPE_BILLING_PORTAL_RETURN_URL (non-empty, look like URLs).
 */

function redactSummary(name, value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return `${name}: MISSING`;
  }
  const s = String(value).trim();
  if (name === 'STRIPE_SECRET_KEY') {
    if (s.startsWith('sk_live_')) return `${name}: INVALID (live key — never use in demo/pilot)`;
    if (s.startsWith('sk_test_')) return `${name}: OK (test mode)`;
    return `${name}: UNEXPECTED_PREFIX (expected sk_test_ for this smoke)`;
  }
  if (name === 'STRIPE_WEBHOOK_SECRET') {
    if (s.startsWith('whsec_')) return `${name}: OK (format)`;
    return `${name}: UNEXPECTED_FORMAT (expected whsec_… from Stripe webhook endpoint)`;
  }
  if (name.includes('URL')) {
    if (/^https?:\/\//i.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      return `${name}: OK (absolute URL)`;
    }
    return `${name}: INVALID (must be absolute, e.g. https://… or yourapp://… )`;
  }
  return `${name}: SET`;
}

function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  const success = process.env.STRIPE_SUCCESS_URL;
  const cancel = process.env.STRIPE_CANCEL_URL;
  const portalReturn = process.env.STRIPE_BILLING_PORTAL_RETURN_URL;

  const lines = [
    redactSummary('STRIPE_SECRET_KEY', key),
    redactSummary('STRIPE_WEBHOOK_SECRET', whsec),
    redactSummary('STRIPE_SUCCESS_URL', success),
    redactSummary('STRIPE_CANCEL_URL', cancel),
    redactSummary('STRIPE_BILLING_PORTAL_RETURN_URL', portalReturn),
  ];

  for (const line of lines) {
    console.log(line);
  }

  let ok = true;
  if (!key || !String(key).trim().startsWith('sk_test_')) ok = false;
  if (String(key || '').trim().startsWith('sk_live_')) ok = false;
  if (!whsec || !String(whsec).trim().startsWith('whsec_')) ok = false;
  for (const u of [success, cancel, portalReturn]) {
    const s = String(u || '').trim();
    if (!s || (!/^https?:\/\//i.test(s) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s))) ok = false;
  }

  if (!ok) {
    console.error('smoke-stripe-env: FAILED — fix items above (see docs/STRIPE_TEST_MODE_PILOT.md)');
    process.exit(1);
  }
  console.log('smoke-stripe-env: OK');
}

main();
