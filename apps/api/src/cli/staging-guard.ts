/**
 * Hard guard for Smart Wallet staging-only tooling. Staging-only commands refuse to run unless
 * BOTH hold:
 *
 * 1. Railway says this process runs in the dedicated staging environment. Railway injects
 *    RAILWAY_ENVIRONMENT_NAME into every deployment and `railway ssh` session; production's is
 *    "production".
 * 2. DATABASE_URL points at a database on Railway's private network (*.railway.internal). The
 *    staging Postgres lives there; production's database is hosted elsewhere, so a production
 *    URL can never pass even if the environment name were wrong.
 *
 * Pure function of the environment so it can be tested exhaustively.
 */
export const SMART_WALLET_STAGING_ENVIRONMENT = 'smart-wallet-staging';

export type StagingGuardResult = { ok: true } | { ok: false; reason: string };

export function checkSmartWalletStagingTarget(env: Record<string, string | undefined>): StagingGuardResult {
  if (env['RAILWAY_ENVIRONMENT_NAME'] !== SMART_WALLET_STAGING_ENVIRONMENT) {
    return { ok: false, reason: 'NOT_THE_SMART_WALLET_STAGING_ENVIRONMENT' };
  }
  const raw = env['DATABASE_URL'];
  if (!raw) return { ok: false, reason: 'DATABASE_URL_MISSING' };
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: 'DATABASE_URL_UNPARSEABLE' };
  }
  if (!host.endsWith('.railway.internal')) {
    return { ok: false, reason: 'DATABASE_NOT_ON_RAILWAY_PRIVATE_NETWORK' };
  }
  return { ok: true };
}
