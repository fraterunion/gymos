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
  out['JWT_ACCESS_TTL'] = assertJwtAccessTtl(out['JWT_ACCESS_TTL']);
  out['JWT_REFRESH_TTL_DAYS'] = assertJwtRefreshTtlDays(out['JWT_REFRESH_TTL_DAYS']);
  out['BCRYPT_ROUNDS'] = assertBcryptRounds(out['BCRYPT_ROUNDS']);
  assertStripeBillingEnv(out, nodeEnv);
  assertExpoBuildWebhookEnv(out, nodeEnv);

  return out;
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
  ['STRIPE_WEBHOOK_SECRET', 'whsec_test_gymos_default_value_for_signature_tests_00001'],
  ['STRIPE_SUCCESS_URL', 'http://localhost:3000/billing/success'],
  ['STRIPE_CANCEL_URL', 'http://localhost:3000/billing/cancel'],
  ['STRIPE_BILLING_PORTAL_RETURN_URL', 'http://localhost:3000/billing/portal-return'],
];

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
