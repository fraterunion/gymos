#!/usr/bin/env node
/**
 * Demo / pilot database reset — guidance only (does not run destructive commands).
 *
 * prisma migrate reset drops ALL tables, reapplies migrations, and runs prisma/seed.ts.
 * Only use against disposable local or dedicated demo databases — never production.
 */

const banner = `
================================================================================
  GYMOS DEMO RESET — DESTRUCTIVE
================================================================================
  This operation (prisma migrate reset) will:
    - DROP all data in the database pointed to by DATABASE_URL
    - Re-apply migrations from scratch
    - Run the Prisma seed (Ares Training Club + Pilates Toluca demo data)

  Do NOT run against production, staging with real members, or shared Neon prod.

  Typical local flow (from monorepo root):
    cd apps/api
    export DATABASE_URL="postgresql://..."   # local Postgres only
    pnpm exec prisma migrate reset --force

  Or from repo root:
    pnpm --filter api exec prisma migrate reset --force

  Re-seed only (keeps schema, wipes and rewrites demo rows via seed.ts):
    pnpm --filter api exec prisma db seed

  See: docs/DEMO_ENVIRONMENT.md
================================================================================
`;

console.log(banner);
process.exitCode = 0;
