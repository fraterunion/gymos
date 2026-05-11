export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const databaseUrl = config['DATABASE_URL'];
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required and must be non-empty');
  }
  const jwtSecret = config['JWT_SECRET'];
  if (typeof jwtSecret !== 'string' || jwtSecret.trim() === '') {
    throw new Error('JWT_SECRET is required and must be non-empty');
  }
  return config;
}
