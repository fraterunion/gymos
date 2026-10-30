import { appleFixture, applyWalletDynamicEnv } from './wallet-dynamic-env';

// Must be imported BEFORE AppModule/config validation (from create-app).
// All credentials, studios and devices below are synthetic and only exist in the CI DB.
if (appleFixture) {
  applyWalletDynamicEnv({ dynamic: true, routes: true, apns: false, worker: false });
  process.env['WALLET_AUTO_ENROLL_ENABLED'] = 'true';
  process.env['WALLET_AUTO_ENROLL_STUDIO_ID'] = 'stage4b-test-studio';
  process.env['WALLET_AUTO_ENROLL_USER_IDS'] = 'stage4b-allowed-user';
  process.env['WALLET_AUTO_ENROLL_STUDIO_CAP'] = '1';
}
