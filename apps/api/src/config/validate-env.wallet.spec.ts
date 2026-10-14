import { validateEnv } from './validate-env';

const BASE: Record<string, unknown> = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  JWT_QR_SECRET: 'y'.repeat(32),
  NODE_ENV: 'test',
};

const APPLE: Record<string, unknown> = {
  WALLET_APPLE_TEAM_ID: 'TEAM123',
  WALLET_APPLE_PASS_TYPE_ID: 'pass.co.gymos.member',
  WALLET_APPLE_SIGNING_CERT_P12_BASE64: 'p12',
  WALLET_APPLE_SIGNING_CERT_PASSWORD: 'pw',
  WALLET_APPLE_WWDR_CERT_PEM_BASE64: 'wwdr',
};

const PROD: Record<string, unknown> = {
  NODE_ENV: 'production',
  CORS_ORIGIN: 'https://admin.example.test',
  STRIPE_SECRET_KEY: 'sk',
  STRIPE_PUBLISHABLE_KEY: 'pk',
  STRIPE_WEBHOOK_SECRET: 'wh',
  STRIPE_SUCCESS_URL: 'https://a.test/s',
  STRIPE_CANCEL_URL: 'https://a.test/c',
  STRIPE_BILLING_PORTAL_RETURN_URL: 'https://a.test/p',
  EXPO_BUILD_WEBHOOK_SECRET: 'z'.repeat(16),
};

const URL_OK = 'https://api.example.test/api/v1/wallet/passkit';

function run(overrides: Record<string, unknown>) {
  return validateEnv({ ...BASE, ...overrides });
}

describe('validateEnv — Smart Wallet 2.0 flags', () => {
  it('defaults every flag OFF and needs nothing else when off', () => {
    const out = run({});
    expect(out['WALLET_DYNAMIC_PASSES_ENABLED']).toBe('false');
    expect(out['WALLET_PASSKIT_ROUTES_ENABLED']).toBe('false');
    expect(out['WALLET_APNS_ENABLED']).toBe('false');
  });

  it('only the word true turns a flag on', () => {
    for (const v of ['1', 'yes', 'on', 'TRUE ', 'enabled', '']) {
      const out = run({ ...APPLE, WALLET_PASSKIT_WEB_SERVICE_URL: URL_OK, WALLET_DYNAMIC_PASSES_ENABLED: v });
      expect(out['WALLET_DYNAMIC_PASSES_ENABLED']).toBe(v.trim().toLowerCase() === 'true' ? 'true' : 'false');
    }
  });

  it('requires the web service URL when dynamic passes or the PassKit routes are on', () => {
    expect(() => run({ ...APPLE, WALLET_DYNAMIC_PASSES_ENABLED: 'true' })).toThrow(/WALLET_PASSKIT_WEB_SERVICE_URL is required/);
    expect(() => run({ ...APPLE, WALLET_PASSKIT_ROUTES_ENABLED: 'true' })).toThrow(/WALLET_PASSKIT_WEB_SERVICE_URL is required/);
  });

  it('requires the full Apple signing configuration when any flag is on', () => {
    expect(() => run({ WALLET_DYNAMIC_PASSES_ENABLED: 'true', WALLET_PASSKIT_WEB_SERVICE_URL: URL_OK })).toThrow(
      /missing: WALLET_APPLE_TEAM_ID, WALLET_APPLE_PASS_TYPE_ID/,
    );
    expect(() => run({ WALLET_APNS_ENABLED: 'true' })).toThrow(/Apple Wallet signing configuration/);
  });

  it('normalizes a valid URL (trailing slash removed)', () => {
    const out = run({ ...APPLE, WALLET_DYNAMIC_PASSES_ENABLED: 'true', WALLET_PASSKIT_WEB_SERVICE_URL: `${URL_OK}/` });
    expect(out['WALLET_PASSKIT_WEB_SERVICE_URL']).toBe(URL_OK);
  });

  it('rejects URLs a signed pass must never carry', () => {
    const bad = [
      'not a url',
      'https://api.example.test/api/v1/wallet',
      'https://api.example.test/wallet/passkit',
      'https://user:pw@api.example.test/api/v1/wallet/passkit',
      'https://api.example.test/api/v1/wallet/passkit?x=1',
      'https://api.example.test/api/v1/wallet/passkit#f',
      'ftp://api.example.test/api/v1/wallet/passkit',
    ];
    for (const url of bad) {
      expect(() => run({ ...APPLE, WALLET_DYNAMIC_PASSES_ENABLED: 'true', WALLET_PASSKIT_WEB_SERVICE_URL: url })).toThrow(
        /WALLET_PASSKIT_WEB_SERVICE_URL/,
      );
    }
  });

  it('allows http only outside production', () => {
    const httpUrl = 'http://192.168.1.20:3000/api/v1/wallet/passkit';
    expect(run({ ...APPLE, WALLET_DYNAMIC_PASSES_ENABLED: 'true', WALLET_PASSKIT_WEB_SERVICE_URL: httpUrl })['WALLET_PASSKIT_WEB_SERVICE_URL']).toBe(httpUrl);
    expect(() =>
      run({ ...PROD, ...APPLE, WALLET_DYNAMIC_PASSES_ENABLED: 'true', WALLET_PASSKIT_WEB_SERVICE_URL: httpUrl }),
    ).toThrow(/must use https in production/);
    expect(
      run({ ...PROD, ...APPLE, WALLET_DYNAMIC_PASSES_ENABLED: 'true', WALLET_PASSKIT_WEB_SERVICE_URL: URL_OK })['WALLET_DYNAMIC_PASSES_ENABLED'],
    ).toBe('true');
  });

  it('production with everything off boots exactly as before (no new requirement)', () => {
    const out = run({ ...PROD });
    expect(out['WALLET_DYNAMIC_PASSES_ENABLED']).toBe('false');
    expect(out['WALLET_PASSKIT_WEB_SERVICE_URL']).toBeUndefined();
  });
});
