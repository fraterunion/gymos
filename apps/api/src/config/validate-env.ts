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
  out['JWT_ACCESS_TTL'] = assertJwtAccessTtl(out['JWT_ACCESS_TTL']);
  out['JWT_REFRESH_TTL_DAYS'] = assertJwtRefreshTtlDays(out['JWT_REFRESH_TTL_DAYS']);
  out['BCRYPT_ROUNDS'] = assertBcryptRounds(out['BCRYPT_ROUNDS']);

  return out;
}
