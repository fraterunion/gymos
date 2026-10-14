import { generateTestApplePkiFixture } from '../../src/wallet/apple/test-cert-fixture';

/**
 * Smart Wallet 2.0 e2e environment. MUST be the first import of a spec that uses it:
 * ConfigModule.forRoot validates (and freezes) the environment when AppModule is imported, so
 * these variables have to exist before that import runs. Signing uses a throwaway test PKI —
 * never a real Apple credential. The flags are only set when the PKI could be generated (the
 * suite is skipped otherwise), because validateEnv refuses wallet flags without signing config.
 */
export const DYNAMIC_PASS_TYPE = 'pass.co.gymos.member.test';
export const DYNAMIC_WEB_SERVICE_URL = 'http://127.0.0.1:3999/api/v1/wallet/passkit';

export const appleFixture = generateTestApplePkiFixture();

export function applyWalletDynamicEnv(flags: { dynamic: boolean; routes: boolean; apns: boolean }): void {
  if (!appleFixture) return;
  process.env['WALLET_APPLE_TEAM_ID'] = 'TEAM123TEST';
  process.env['WALLET_APPLE_PASS_TYPE_ID'] = DYNAMIC_PASS_TYPE;
  process.env['WALLET_APPLE_SIGNING_CERT_P12_BASE64'] = appleFixture.p12Base64;
  process.env['WALLET_APPLE_SIGNING_CERT_PASSWORD'] = appleFixture.p12Password;
  process.env['WALLET_APPLE_WWDR_CERT_PEM_BASE64'] = appleFixture.wwdrPemBase64;
  process.env['WALLET_DYNAMIC_PASSES_ENABLED'] = String(flags.dynamic);
  process.env['WALLET_PASSKIT_ROUTES_ENABLED'] = String(flags.routes);
  process.env['WALLET_APNS_ENABLED'] = String(flags.apns);
  process.env['WALLET_PASSKIT_WEB_SERVICE_URL'] = DYNAMIC_WEB_SERVICE_URL;
}
