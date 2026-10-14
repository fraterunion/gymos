import { checkSmartWalletStagingTarget, SMART_WALLET_STAGING_ENVIRONMENT } from './staging-guard';

const STAGING_DB = 'postgresql://postgres:secret@postgres.railway.internal:5432/railway';

describe('checkSmartWalletStagingTarget', () => {
  it('allows only the staging environment with a Railway private-network database', () => {
    expect(checkSmartWalletStagingTarget({ RAILWAY_ENVIRONMENT_NAME: SMART_WALLET_STAGING_ENVIRONMENT, DATABASE_URL: STAGING_DB })).toEqual({ ok: true });
  });

  it('refuses production, unnamed or other environments', () => {
    for (const name of ['production', 'Production', 'smart-wallet-staging ', 'staging', undefined]) {
      expect(checkSmartWalletStagingTarget({ RAILWAY_ENVIRONMENT_NAME: name, DATABASE_URL: STAGING_DB })).toEqual({
        ok: false,
        reason: 'NOT_THE_SMART_WALLET_STAGING_ENVIRONMENT',
      });
    }
  });

  it('refuses any database that is not on the Railway private network, even in staging', () => {
    const env = (DATABASE_URL: string | undefined) => ({ RAILWAY_ENVIRONMENT_NAME: SMART_WALLET_STAGING_ENVIRONMENT, DATABASE_URL });
    expect(checkSmartWalletStagingTarget(env('postgresql://u:p@ep-cool-name-123.us-east-2.aws.neon.tech/neondb?sslmode=require'))).toEqual({
      ok: false,
      reason: 'DATABASE_NOT_ON_RAILWAY_PRIVATE_NETWORK',
    });
    expect(checkSmartWalletStagingTarget(env('postgresql://u:p@localhost:5432/gymos'))).toMatchObject({ ok: false });
    expect(checkSmartWalletStagingTarget(env('postgresql://u:p@railway.internal.evil.example/db'))).toMatchObject({ ok: false });
    expect(checkSmartWalletStagingTarget(env('postgresql://u:p@x.proxy.rlwy.net:12345/railway'))).toMatchObject({ ok: false });
    expect(checkSmartWalletStagingTarget(env(undefined))).toEqual({ ok: false, reason: 'DATABASE_URL_MISSING' });
    expect(checkSmartWalletStagingTarget(env('not a url'))).toEqual({ ok: false, reason: 'DATABASE_URL_UNPARSEABLE' });
  });
});
