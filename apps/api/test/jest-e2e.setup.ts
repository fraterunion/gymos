if (!process.env['DATABASE_URL']?.trim()) {
  throw new Error('DATABASE_URL must be set for e2e tests (use a dedicated PostgreSQL database).');
}

/** Disables rate limits so e2e suites can perform many logins without 429. */
process.env['GYMOS_E2E'] = '1';
