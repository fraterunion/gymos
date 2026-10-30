import { isAutoEnrollmentEligible, validateAutoEnrollmentEnv } from './wallet-auto-enrollment.config';

describe('Stage 4B enrollment safety', () => {
  const values = {
    WALLET_AUTO_ENROLL_ENABLED: 'true',
    WALLET_DYNAMIC_PASSES_ENABLED: 'true',
    WALLET_PASSKIT_ROUTES_ENABLED: 'true',
    WALLET_AUTO_ENROLL_STUDIO_ID: 'studio-ares',
    WALLET_AUTO_ENROLL_USER_IDS: 'user-one,user-two',
    WALLET_AUTO_ENROLL_STUDIO_CAP: '2',
  };

  it('defaults OFF, allowing existing production configurations unchanged', () => {
    const env: Record<string, unknown> = {};
    validateAutoEnrollmentEnv(env);
    expect(env.WALLET_AUTO_ENROLL_ENABLED).toBe('false');
  });

  it('allows only exact studio and users', () => {
    const env = { ...values };
    validateAutoEnrollmentEnv(env);
    const config = { get: (key: string) => (env as Record<string, string>)[key] };
    expect(isAutoEnrollmentEligible(config as never, 'studio-ares', 'user-one')).toBe(true);
    expect(isAutoEnrollmentEligible(config as never, 'studio-other', 'user-one')).toBe(false);
    expect(isAutoEnrollmentEligible(config as never, 'studio-ares', 'user-three')).toBe(false);
  });

  it.each([
    [{ ...values, WALLET_AUTO_ENROLL_USER_IDS: '*' }, 'wildcard'],
    [{ ...values, WALLET_AUTO_ENROLL_USER_IDS: 'user-one,user-one' }, 'duplicate'],
    [{ ...values, WALLET_AUTO_ENROLL_STUDIO_CAP: '1' }, 'cap'],
    [{ ...values, WALLET_PASSKIT_ROUTES_ENABLED: 'false' }, 'routes'],
    [{ ...values, WALLET_DYNAMIC_PASSES_ENABLED: 'false' }, 'dynamic'],
    [{ ...values, WALLET_AUTO_ENROLL_STUDIO_ID: '' }, 'studio'],
  ])('rejects unsafe rollout configuration (%s: %s)', (env) => {
    expect(() => validateAutoEnrollmentEnv(env)).toThrow();
  });
});
