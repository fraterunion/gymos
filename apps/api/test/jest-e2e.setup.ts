if (!process.env['DATABASE_URL']?.trim()) {
  throw new Error('DATABASE_URL must be set for e2e tests (use a dedicated PostgreSQL database).');
}
