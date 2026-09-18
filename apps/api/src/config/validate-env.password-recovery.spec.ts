import { validateEnv } from './validate-env';

/**
 * Boot-time guard for password recovery. Production must never come up with the feature
 * switched on but undeliverable — the process is expected to refuse to start, which on
 * Railway leaves the previous deployment serving.
 */

const BASE = {
  DATABASE_URL: 'postgresql://user@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  JWT_QR_SECRET: 'y'.repeat(32),
  CORS_ORIGIN: 'https://admin.example.com,https://preview.example.app',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
  STRIPE_SUCCESS_URL: 'https://admin.example.com/ok',
  STRIPE_CANCEL_URL: 'https://admin.example.com/cancel',
  STRIPE_BILLING_PORTAL_RETURN_URL: 'https://admin.example.com/billing',
  EXPO_BUILD_WEBHOOK_SECRET: 'z'.repeat(24),
};

function env(overrides: Record<string, unknown>): Record<string, unknown> {
  return validateEnv({ ...BASE, ...overrides });
}

describe('validateEnv — password recovery gating', () => {
  describe('defaults', () => {
    it('is OFF by default in production (must be enabled deliberately)', () => {
      expect(env({ NODE_ENV: 'production' })['PASSWORD_RECOVERY_ENABLED']).toBe('false');
    });

    it('is ON by default outside production so dev/test keep working', () => {
      expect(env({ NODE_ENV: 'development' })['PASSWORD_RECOVERY_ENABLED']).toBe('true');
      expect(env({ NODE_ENV: 'test' })['PASSWORD_RECOVERY_ENABLED']).toBe('true');
    });

    it('normalizes the flag to a strict boolean string', () => {
      // 'TRUE' really does enable it — so the delivery requirements apply too.
      const on = env({
        NODE_ENV: 'production',
        PASSWORD_RECOVERY_ENABLED: 'TRUE',
        RESEND_API_KEY: 're_live_xxx',
        EMAIL_FROM_ADDRESS: 'no-reply@mail.example.com',
        PASSWORD_RESET_URL_BASE: 'https://admin.example.com',
      });
      expect(on['PASSWORD_RECOVERY_ENABLED']).toBe('true');
      // Anything that is not exactly true/false is treated as OFF — fail closed.
      expect(env({ NODE_ENV: 'production', PASSWORD_RECOVERY_ENABLED: 'yes' })['PASSWORD_RECOVERY_ENABLED']).toBe('false');
    });
  });

  describe('production with recovery enabled', () => {
    const enabled = {
      NODE_ENV: 'production',
      PASSWORD_RECOVERY_ENABLED: 'true',
      RESEND_API_KEY: 're_live_xxx',
      EMAIL_FROM_ADDRESS: 'no-reply@mail.example.com',
      PASSWORD_RESET_URL_BASE: 'https://admin.example.com',
    };

    it('accepts a complete configuration', () => {
      const out = env(enabled);
      expect(out['PASSWORD_RECOVERY_ENABLED']).toBe('true');
      expect(out['PASSWORD_RESET_URL_BASE']).toBe('https://admin.example.com');
    });

    it('refuses to boot without an API key', () => {
      expect(() => env({ ...enabled, RESEND_API_KEY: '' })).toThrow(/RESEND_API_KEY is required/);
    });

    it('refuses to boot without a valid sender address', () => {
      expect(() => env({ ...enabled, EMAIL_FROM_ADDRESS: undefined })).toThrow(/EMAIL_FROM_ADDRESS/);
      expect(() => env({ ...enabled, EMAIL_FROM_ADDRESS: 'not-an-email' })).toThrow(/EMAIL_FROM_ADDRESS/);
    });

    it('refuses to boot without an explicit reset URL base', () => {
      expect(() => env({ ...enabled, PASSWORD_RESET_URL_BASE: undefined })).toThrow(
        /PASSWORD_RESET_URL_BASE is required/,
      );
    });

    it('requires the reset URL to be absolute and https', () => {
      expect(() => env({ ...enabled, PASSWORD_RESET_URL_BASE: '/reset' })).toThrow(/absolute URL/);
      expect(() => env({ ...enabled, PASSWORD_RESET_URL_BASE: 'http://admin.example.com' })).toThrow(
        /must use https/,
      );
    });

    it('never derives the reset URL from CORS_ORIGIN', () => {
      // CORS_ORIGIN's first entry is a deploy-specific host; silently reusing it would mail
      // members links to the wrong surface.
      const out = env(enabled);
      expect(out['PASSWORD_RESET_URL_BASE']).not.toContain('preview.example.app');
    });
  });

  describe('production with recovery disabled', () => {
    it('boots with no email configuration at all', () => {
      const out = env({ NODE_ENV: 'production', PASSWORD_RECOVERY_ENABLED: 'false' });
      expect(out['PASSWORD_RECOVERY_ENABLED']).toBe('false');
      expect(out['RESEND_API_KEY']).toBeUndefined();
    });
  });

  describe('non-production', () => {
    it('allows the feature on with no delivery configured (suppressing provider)', () => {
      const out = env({ NODE_ENV: 'development', PASSWORD_RECOVERY_ENABLED: 'true' });
      expect(out['PASSWORD_RECOVERY_ENABLED']).toBe('true');
    });
  });
});
