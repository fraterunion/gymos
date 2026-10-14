import { APPLE_WALLET_ENV_KEYS } from '../wallet/apple/apple-wallet.constants';

const NODE_ENVS = ['development', 'test', 'production'] as const;
type NodeEnv = (typeof NODE_ENVS)[number];

function isNodeEnv(v: string): v is NodeEnv {
  return (NODE_ENVS as readonly string[]).includes(v);
}

function assertJwtAccessTtl(v: unknown): string {
  if (v === undefined || v === null || v === '') {
    return '15m';
  }
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error('JWT_ACCESS_TTL must be a non-empty string when set');
  }
  const s = v.trim();
  if (s.length > 32) {
    throw new Error('JWT_ACCESS_TTL is too long');
  }
  return s;
}

function assertBcryptRounds(v: unknown): string {
  if (v === undefined || v === null || v === '') {
    return '12';
  }
  const raw = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (raw === '') {
    throw new Error('BCRYPT_ROUNDS must be a non-empty value when set');
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 31) {
    throw new Error('BCRYPT_ROUNDS must be an integer between 1 and 31');
  }
  return String(n);
}

function assertJwtRefreshTtlDays(v: unknown): string {
  if (v === undefined || v === null || v === '') {
    return '30';
  }
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error('JWT_REFRESH_TTL_DAYS must be a non-empty string when set');
  }
  const n = Number(v.trim());
  if (!Number.isFinite(n) || n < 1 || n > 3650 || !Number.isInteger(n)) {
    throw new Error('JWT_REFRESH_TTL_DAYS must be a positive integer between 1 and 3650');
  }
  return String(n);
}

function assertCorsOrigin(v: unknown, nodeEnv: NodeEnv): string {
  const isProd = nodeEnv === 'production';
  if (isProd) {
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error('CORS_ORIGIN is required in production');
    }
  } else {
    if (v === undefined || v === null || v === '') {
      return 'http://localhost:3000';
    }
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error('CORS_ORIGIN must be a non-empty string when set');
    }
  }
  const raw = typeof v === 'string' && v.trim() !== '' ? v.trim() : 'http://localhost:3000';
  const origins = raw.split(',').map((o) => o.trim());
  if (origins.some((o) => o === '*')) {
    throw new Error('CORS_ORIGIN must not be "*"');
  }
  return raw;
}

function normalizeBuildWorkerEnabled(v: unknown): string {
  if (v === undefined || v === null || v === '') return 'false';
  if (typeof v === 'string' && v.trim().toLowerCase() === 'true') return 'true';
  return 'false';
}

/** MM-4: multi-membership CREATION gate (may a new compatible simultaneous membership be
 *  created?). Defaults to 'false' — creation acceptance stays legacy until rollout flips it;
 *  family scoping of existing memberships is always on and not controlled by this flag. */
function normalizeMultiMembershipEnabled(v: unknown): string {
  if (typeof v === 'string' && v.trim().toLowerCase() === 'true') return 'true';
  return 'false';
}

/** Password recovery depends on outbound email, which is a per-environment capability.
 *  Defaults: OFF in production (must be turned on deliberately, with delivery configured),
 *  ON everywhere else (dev/test run against the suppressing provider). */
function normalizePasswordRecoveryEnabled(v: unknown, nodeEnv: NodeEnv): string {
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true') return 'true';
    if (t === 'false') return 'false';
  }
  return nodeEnv === 'production' ? 'false' : 'true';
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };

  const databaseUrl = out['DATABASE_URL'];
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required and must be non-empty');
  }

  const jwtSecret = out['JWT_SECRET'];
  if (typeof jwtSecret !== 'string' || jwtSecret.trim() === '') {
    throw new Error('JWT_SECRET is required and must be non-empty');
  }

  const jwtQrSecret = out['JWT_QR_SECRET'];
  if (typeof jwtQrSecret !== 'string' || jwtQrSecret.trim() === '') {
    throw new Error('JWT_QR_SECRET is required and must be non-empty');
  }

  let nodeEnvRaw = out['NODE_ENV'];
  if (nodeEnvRaw === undefined || nodeEnvRaw === null || nodeEnvRaw === '') {
    out['NODE_ENV'] = 'development';
    nodeEnvRaw = 'development';
  }
  if (typeof nodeEnvRaw !== 'string' || !isNodeEnv(nodeEnvRaw)) {
    throw new Error(`NODE_ENV must be one of: ${NODE_ENVS.join(', ')}`);
  }
  const nodeEnv = nodeEnvRaw;

  out['CORS_ORIGIN'] = assertCorsOrigin(out['CORS_ORIGIN'], nodeEnv);
  const corsFirst =
    typeof out['CORS_ORIGIN'] === 'string' ? out['CORS_ORIGIN'].split(',')[0]?.trim() : undefined;
  if (!out['EXPO_PUBLIC_API_URL'] || (typeof out['EXPO_PUBLIC_API_URL'] === 'string' && out['EXPO_PUBLIC_API_URL'].trim() === '')) {
    if (corsFirst) {
      out['EXPO_PUBLIC_API_URL'] = corsFirst;
    }
  }
  out['BUILD_WORKER_ENABLED'] = normalizeBuildWorkerEnabled(out['BUILD_WORKER_ENABLED']);
  out['MULTI_MEMBERSHIP_ENABLED'] = normalizeMultiMembershipEnabled(out['MULTI_MEMBERSHIP_ENABLED']);
  out['JWT_ACCESS_TTL'] = assertJwtAccessTtl(out['JWT_ACCESS_TTL']);
  out['JWT_REFRESH_TTL_DAYS'] = assertJwtRefreshTtlDays(out['JWT_REFRESH_TTL_DAYS']);
  out['BCRYPT_ROUNDS'] = assertBcryptRounds(out['BCRYPT_ROUNDS']);
  out['PASSWORD_RECOVERY_ENABLED'] = normalizePasswordRecoveryEnabled(
    out['PASSWORD_RECOVERY_ENABLED'],
    nodeEnv,
  );
  assertPasswordRecoveryEnv(out, nodeEnv);
  assertStripeBillingEnv(out, nodeEnv);
  assertExpoBuildWebhookEnv(out, nodeEnv);
  assertDayPassEnv(out);
  assertWalletPassEnv(out, nodeEnv);

  return out;
}

const WALLET_FLAG_KEYS = [
  'WALLET_DYNAMIC_PASSES_ENABLED',
  'WALLET_PASSKIT_ROUTES_ENABLED',
  'WALLET_APNS_ENABLED',
] as const;
const PASSKIT_ROUTE_SUFFIX = '/api/v1/wallet/passkit';

/**
 * Smart Wallet 2.0 (Stage 1A). Every flag is normalised to 'true' | 'false' and defaults OFF.
 *
 * WALLET_PASSKIT_WEB_SERVICE_URL is validated hard because it is SIGNED into every dynamic
 * pass: a pass carrying a wrong URL can never fetch the update that would correct it. It must
 * be an absolute https URL (http only outside production, for device testing with Wallet's
 * developer "Allow HTTP Services" setting) without credentials, query or fragment, and must
 * point at this API's PassKit controller. Any capability that signs passes or talks to APNs
 * also requires the complete Apple signing configuration, so a misconfigured deploy refuses
 * to boot rather than failing per request.
 */
function assertWalletPassEnv(out: Record<string, unknown>, nodeEnv: NodeEnv): void {
  for (const key of WALLET_FLAG_KEYS) {
    const v = out[key];
    out[key] = typeof v === 'string' && v.trim().toLowerCase() === 'true' ? 'true' : 'false';
  }
  const anyOn = WALLET_FLAG_KEYS.some((key) => out[key] === 'true');
  const needsUrl = out['WALLET_DYNAMIC_PASSES_ENABLED'] === 'true' || out['WALLET_PASSKIT_ROUTES_ENABLED'] === 'true';

  const rawUrl = out['WALLET_PASSKIT_WEB_SERVICE_URL'];
  if (typeof rawUrl === 'string' && rawUrl.trim() !== '') {
    out['WALLET_PASSKIT_WEB_SERVICE_URL'] = normalizePasskitWebServiceUrl(rawUrl.trim(), nodeEnv);
  } else if (needsUrl) {
    throw new Error(
      'WALLET_PASSKIT_WEB_SERVICE_URL is required when WALLET_DYNAMIC_PASSES_ENABLED or WALLET_PASSKIT_ROUTES_ENABLED is true',
    );
  }

  if (anyOn) {
    const missing = APPLE_WALLET_ENV_KEYS.filter((key) => {
      const v = out[key];
      return typeof v !== 'string' || v.trim() === '';
    });
    if (missing.length > 0) {
      throw new Error(`Smart Wallet flags require the Apple Wallet signing configuration; missing: ${missing.join(', ')}`);
    }
  }
}

function normalizePasskitWebServiceUrl(raw: string, nodeEnv: NodeEnv): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('WALLET_PASSKIT_WEB_SERVICE_URL must be an absolute URL');
  }
  const httpsOnly = nodeEnv === 'production';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !httpsOnly)) {
    throw new Error(`WALLET_PASSKIT_WEB_SERVICE_URL must use https${httpsOnly ? ' in production' : ' (or http outside production)'}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('WALLET_PASSKIT_WEB_SERVICE_URL must not contain credentials, a query or a fragment');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith(PASSKIT_ROUTE_SUFFIX)) {
    throw new Error(`WALLET_PASSKIT_WEB_SERVICE_URL must end with ${PASSKIT_ROUTE_SUFFIX}`);
  }
  return `${url.origin}${path}`;
}

/**
 * Fail-fast so production can never serve a working-looking recovery UI that silently
 * delivers nothing: with the feature ON in production, every piece of delivery
 * configuration must be present and well-formed, or the process refuses to boot (Railway
 * then keeps the previous deployment serving). Non-production may run it against the
 * suppressing provider.
 */
function assertPasswordRecoveryEnv(out: Record<string, unknown>, nodeEnv: NodeEnv): void {
  if (out['PASSWORD_RECOVERY_ENABLED'] !== 'true' || nodeEnv !== 'production') {
    return;
  }

  const apiKey = out['RESEND_API_KEY'];
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error(
      'RESEND_API_KEY is required when PASSWORD_RECOVERY_ENABLED=true in production',
    );
  }

  const from = out['EMAIL_FROM_ADDRESS'];
  if (typeof from !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from.trim())) {
    throw new Error(
      'EMAIL_FROM_ADDRESS is required and must be a valid address when PASSWORD_RECOVERY_ENABLED=true in production',
    );
  }

  // Must be an absolute public URL: the reset link is opened from an email client, where
  // a relative or localhost URL is useless. Never derived from CORS_ORIGIN — that list is
  // ordered for browser origins, not for the surface that serves /reset-password.
  const base = out['PASSWORD_RESET_URL_BASE'];
  if (typeof base !== 'string' || base.trim() === '') {
    throw new Error(
      'PASSWORD_RESET_URL_BASE is required when PASSWORD_RECOVERY_ENABLED=true in production',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(base.trim());
  } catch {
    throw new Error('PASSWORD_RESET_URL_BASE must be an absolute URL (https://…)');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('PASSWORD_RESET_URL_BASE must use https in production');
  }
  out['PASSWORD_RESET_URL_BASE'] = base.trim();
}

function assertExpoBuildWebhookEnv(out: Record<string, unknown>, nodeEnv: NodeEnv): void {
  const secret = out['EXPO_BUILD_WEBHOOK_SECRET'];
  if (nodeEnv === 'production') {
    if (typeof secret !== 'string' || secret.trim().length < 16) {
      throw new Error(
        'EXPO_BUILD_WEBHOOK_SECRET is required in production (min 16 characters, same as eas webhook:create)',
      );
    }
    return;
  }
  if (typeof secret === 'string' && secret.trim() !== '' && secret.trim().length < 16) {
    throw new Error('EXPO_BUILD_WEBHOOK_SECRET must be at least 16 characters when set');
  }
}

const STRIPE_DEFAULTS: ReadonlyArray<[string, string]> = [
  [
    'STRIPE_SECRET_KEY',
    // Stripe publishes this sample test secret for SDK examples (test mode only).
    'sk_test_REPLACE_ME',
  ],
  ['STRIPE_PUBLISHABLE_KEY', 'pk_test_REPLACE_ME'],
  ['STRIPE_WEBHOOK_SECRET', 'whsec_test_gymos_default_value_for_signature_tests_00001'],
  ['STRIPE_SUCCESS_URL', 'http://localhost:3000/billing/success'],
  ['STRIPE_CANCEL_URL', 'http://localhost:3000/billing/cancel'],
  ['STRIPE_BILLING_PORTAL_RETURN_URL', 'http://localhost:3000/billing/portal-return'],
];

function assertDayPassEnv(out: Record<string, unknown>): void {
  const priceRaw = out['DAY_PASS_PRICE_CENTS'];
  if (priceRaw === undefined || priceRaw === null || priceRaw === '') {
    out['DAY_PASS_PRICE_CENTS'] = '20000';
  } else {
    const n = Number(String(priceRaw).trim());
    if (!Number.isInteger(n) || n < 1) {
      throw new Error('DAY_PASS_PRICE_CENTS must be a positive integer when set');
    }
    out['DAY_PASS_PRICE_CENTS'] = String(n);
  }

  const currencyRaw = out['DAY_PASS_CURRENCY'];
  if (currencyRaw === undefined || currencyRaw === null || currencyRaw === '') {
    out['DAY_PASS_CURRENCY'] = 'mxn';
  } else {
    const c = String(currencyRaw).trim().toLowerCase();
    if (c.length < 2 || c.length > 10 || !/^[a-z]+$/.test(c)) {
      throw new Error('DAY_PASS_CURRENCY must be a 2–10 character lowercase currency code when set');
    }
    out['DAY_PASS_CURRENCY'] = c;
  }

  // Day Pass lapse sweep switches, normalised to '1' | '0'. Anything but an explicit true/1 is
  // OFF: the sweep does not run at all unless DAY_PASS_SWEEP_ENABLED=1, and even then it only
  // cancels PaymentIntents at Stripe when DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS=1.
  for (const key of ['DAY_PASS_SWEEP_ENABLED', 'DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS']) {
    const norm = String(out[key] ?? '').trim().toLowerCase();
    out[key] = norm === '1' || norm === 'true' ? '1' : '0';
  }
}

function assertStripeBillingEnv(out: Record<string, unknown>, nodeEnv: NodeEnv): void {
  if (nodeEnv === 'production') {
    for (const [key] of STRIPE_DEFAULTS) {
      const v = out[key];
      if (typeof v !== 'string' || v.trim() === '') {
        throw new Error(`${key} is required in production for Stripe billing`);
      }
    }
    return;
  }
  for (const [key, def] of STRIPE_DEFAULTS) {
    const v = out[key];
    if (typeof v !== 'string' || v.trim() === '') {
      out[key] = def;
    }
  }
}
