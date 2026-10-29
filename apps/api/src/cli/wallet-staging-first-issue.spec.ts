import { checkLiveFirstIssueGate, firstIssueAllowlistConfig, validateProposedAllowlist, type ConfigGetter } from './wallet-staging-first-issue';

const STUDIO = 'cmstagingstudio0001';
const C = 'cmstagingmemberc001';
const A = 'cmstagingmembera001';
const B = 'cmstagingmemberb001';

function config(values: Record<string, string | undefined>): ConfigGetter {
  return { get: ((key: string) => values[key]) as ConfigGetter['get'] };
}

const LIVE_OK = {
  WALLET_AUTO_ENROLL_ENABLED: 'true',
  WALLET_AUTO_ENROLL_STUDIO_ID: STUDIO,
  WALLET_AUTO_ENROLL_USER_IDS: C,
  WALLET_AUTO_ENROLL_STUDIO_CAP: '1',
  WALLET_DYNAMIC_PASSES_ENABLED: 'true',
  WALLET_PASSKIT_ROUTES_ENABLED: 'true',
  WALLET_REFRESH_WORKER_ENABLED: 'false',
};

describe('Stage 4B staging first-issue allowlist (member C)', () => {
  it('produces exactly the four allowlist variables for one member, cap 1', () => {
    expect(firstIssueAllowlistConfig(STUDIO, C)).toEqual({
      WALLET_AUTO_ENROLL_ENABLED: 'true',
      WALLET_AUTO_ENROLL_STUDIO_ID: STUDIO,
      WALLET_AUTO_ENROLL_USER_IDS: C,
      WALLET_AUTO_ENROLL_STUDIO_CAP: '1',
    });
  });

  describe('validateProposedAllowlist', () => {
    const ctx = { studioId: STUDIO, firstIssueUserId: C, otherUserIds: [A, B] };

    it('accepts the generated allowlist: boot validation passes, C is admitted, A and B are not', () => {
      expect(validateProposedAllowlist(firstIssueAllowlistConfig(STUDIO, C), ctx)).toEqual([]);
    });

    it('rejects a wildcard (the API boot validator refuses it too)', () => {
      const p = validateProposedAllowlist({ ...firstIssueAllowlistConfig(STUDIO, C), WALLET_AUTO_ENROLL_USER_IDS: '*' }, ctx);
      expect(p).toEqual(expect.arrayContaining([expect.stringMatching(/^BOOT_VALIDATION_REJECTS/), 'ALLOWLIST_IS_NOT_EXACTLY_THIS_MEMBER']));
    });

    it('rejects an allowlist that also admits an existing user, and a cap above 1', () => {
      const p = validateProposedAllowlist(
        { ...firstIssueAllowlistConfig(STUDIO, C), WALLET_AUTO_ENROLL_USER_IDS: `${C},${A}`, WALLET_AUTO_ENROLL_STUDIO_CAP: '2' },
        ctx,
      );
      expect(p).toEqual(expect.arrayContaining(['ALLOWLIST_IS_NOT_EXACTLY_THIS_MEMBER', 'CAP_IS_NOT_1', 'ALLOWLIST_ADMITS_OTHER_USERS: 1']));
    });

    it('rejects a different studio', () => {
      const p = validateProposedAllowlist(firstIssueAllowlistConfig('cmsomeotherstudio1', C), ctx);
      expect(p).toContain('INTENDED_MEMBER_NOT_ELIGIBLE');
    });
  });

  describe('checkLiveFirstIssueGate', () => {
    const ctx = { studioId: STUDIO, firstIssueUserId: C, credentialedUserIds: [A, B] };

    it('passes only for the exact live configuration', () => {
      expect(checkLiveFirstIssueGate(config(LIVE_OK), ctx)).toEqual([]);
    });

    it.each([
      ['auto-enrollment off', { WALLET_AUTO_ENROLL_ENABLED: 'false' }, 'AUTO_ENROLL_NOT_ENABLED'],
      ['dynamic passes off', { WALLET_DYNAMIC_PASSES_ENABLED: 'false' }, 'DYNAMIC_PASSES_DISABLED'],
      ['PassKit routes off', { WALLET_PASSKIT_ROUTES_ENABLED: 'false' }, 'PASSKIT_ROUTES_DISABLED'],
      ['refresh worker on', { WALLET_REFRESH_WORKER_ENABLED: 'true' }, 'REFRESH_WORKER_ENABLED'],
      ['another studio', { WALLET_AUTO_ENROLL_STUDIO_ID: 'cmsomeotherstudio1' }, 'STUDIO_IS_NOT_THE_SYNTHETIC_STAGING_STUDIO'],
      ['a wildcard', { WALLET_AUTO_ENROLL_USER_IDS: '*' }, 'WILDCARD_IN_ALLOWLIST'],
      ['a second member', { WALLET_AUTO_ENROLL_USER_IDS: `${C},cmanothernewuser01` }, 'ALLOWLIST_IS_NOT_EXACTLY_THIS_MEMBER'],
      ['a user with an existing credential', { WALLET_AUTO_ENROLL_USER_IDS: `${C},${A}` }, 'ALLOWLIST_NAMES_A_USER_WITH_AN_EXISTING_CREDENTIAL'],
      ['only an existing credential holder', { WALLET_AUTO_ENROLL_USER_IDS: B }, 'ALLOWLIST_NAMES_A_USER_WITH_AN_EXISTING_CREDENTIAL'],
      ['cap 2', { WALLET_AUTO_ENROLL_STUDIO_CAP: '2' }, 'CAP_IS_NOT_1'],
      ['missing user ids', { WALLET_AUTO_ENROLL_USER_IDS: undefined }, 'INTENDED_MEMBER_NOT_ELIGIBLE_AT_RUNTIME'],
    ])('refuses %s', (_label, override, problem) => {
      expect(checkLiveFirstIssueGate(config({ ...LIVE_OK, ...override }), ctx)).toContain(problem);
    });
  });
});
