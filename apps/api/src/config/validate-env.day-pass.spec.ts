import { validateEnv } from './validate-env';

const BASE = {
  DATABASE_URL: 'postgresql://user@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  JWT_QR_SECRET: 'y'.repeat(32),
  CORS_ORIGIN: 'https://admin.example.com',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
  STRIPE_SUCCESS_URL: 'https://admin.example.com/ok',
  STRIPE_CANCEL_URL: 'https://admin.example.com/cancel',
  STRIPE_BILLING_PORTAL_RETURN_URL: 'https://admin.example.com/billing',
  EXPO_BUILD_WEBHOOK_SECRET: 'z'.repeat(24),
};

describe('validateEnv — Day Pass sweep Stripe cancellation flag', () => {
  it('defaults to OFF (bookkeeping-only sweep) when unset or unrecognised', () => {
    expect(validateEnv({ ...BASE })['DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS']).toBe('0');
    expect(validateEnv({ ...BASE, DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS: 'yes' })['DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS']).toBe('0');
    expect(validateEnv({ ...BASE, DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS: '' })['DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS']).toBe('0');
  });

  it('turns ON only for an explicit 1 / true', () => {
    expect(validateEnv({ ...BASE, DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS: '1' })['DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS']).toBe('1');
    expect(validateEnv({ ...BASE, DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS: 'TRUE' })['DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS']).toBe('1');
  });
});

describe('validateEnv — Day Pass sweep master switch', () => {
  it('is OFF unless explicitly enabled, so a deploy never mutates existing attempts', () => {
    expect(validateEnv({ ...BASE })['DAY_PASS_SWEEP_ENABLED']).toBe('0');
    expect(validateEnv({ ...BASE, DAY_PASS_SWEEP_ENABLED: 'on' })['DAY_PASS_SWEEP_ENABLED']).toBe('0');
    expect(validateEnv({ ...BASE, DAY_PASS_SWEEP_ENABLED: '1' })['DAY_PASS_SWEEP_ENABLED']).toBe('1');
    expect(validateEnv({ ...BASE, DAY_PASS_SWEEP_ENABLED: 'true' })['DAY_PASS_SWEEP_ENABLED']).toBe('1');
  });
});
