import type { ConfigService } from '@nestjs/config';
import {
  isAutoEnrollmentEligible,
  validateAutoEnrollmentEnv,
  WALLET_AUTO_ENROLL_ENABLED,
  WALLET_AUTO_ENROLL_STUDIO_CAP,
  WALLET_AUTO_ENROLL_STUDIO_ID,
  WALLET_AUTO_ENROLL_USER_IDS,
} from '../wallet/dynamic/wallet-auto-enrollment.config';

/**
 * Stage 4B staging validation (synthetic member C). Pure checks around the auto-enrollment
 * allowlist, kept apart from the commands so they are unit-tested exhaustively.
 *
 * The cohort is exactly ONE synthetic user: cap 1, no wildcard, no other user, never a user who
 * already holds a wallet credential (existing passes are never auto-enrolled, and an allowlist
 * that names an existing holder would mean someone is being opted in by mistake).
 */
export const FIRST_ISSUE_COHORT_CAP = '1';

export type ConfigGetter = Pick<ConfigService, 'get'>;

export function firstIssueAllowlistConfig(studioId: string, userId: string): Record<string, string> {
  return {
    [WALLET_AUTO_ENROLL_ENABLED]: 'true',
    [WALLET_AUTO_ENROLL_STUDIO_ID]: studioId,
    [WALLET_AUTO_ENROLL_USER_IDS]: userId,
    [WALLET_AUTO_ENROLL_STUDIO_CAP]: FIRST_ISSUE_COHORT_CAP,
  };
}

function getterOf(values: Record<string, string | undefined>): ConfigGetter {
  return { get: ((key: string) => values[key]) as ConfigGetter['get'] };
}

/**
 * Validates a PROPOSED allowlist before anyone sets it: the API's own boot-time validator must
 * accept it (with the flags Stage 4B requires), the runtime policy must admit exactly the
 * intended user, and no other user in the database may be admitted.
 */
export function validateProposedAllowlist(
  proposed: Record<string, string>,
  ctx: { studioId: string; firstIssueUserId: string; otherUserIds: readonly string[] },
): string[] {
  const problems: string[] = [];
  const boot: Record<string, unknown> = { ...proposed, WALLET_DYNAMIC_PASSES_ENABLED: 'true', WALLET_PASSKIT_ROUTES_ENABLED: 'true' };
  try {
    validateAutoEnrollmentEnv(boot);
  } catch (err) {
    problems.push(`BOOT_VALIDATION_REJECTS: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ids = (proposed[WALLET_AUTO_ENROLL_USER_IDS] ?? '').split(',').map((id) => id.trim());
  if (ids.length !== 1 || ids[0] !== ctx.firstIssueUserId) problems.push('ALLOWLIST_IS_NOT_EXACTLY_THIS_MEMBER');
  if (proposed[WALLET_AUTO_ENROLL_STUDIO_CAP] !== FIRST_ISSUE_COHORT_CAP) problems.push('CAP_IS_NOT_1');
  const policy = getterOf(boot as Record<string, string | undefined>);
  if (!isAutoEnrollmentEligible(policy, ctx.studioId, ctx.firstIssueUserId)) problems.push('INTENDED_MEMBER_NOT_ELIGIBLE');
  const admitted = ctx.otherUserIds.filter((id) => isAutoEnrollmentEligible(policy, ctx.studioId, id));
  if (admitted.length > 0) problems.push(`ALLOWLIST_ADMITS_OTHER_USERS: ${admitted.length}`);
  return problems;
}

/**
 * Gate on the LIVE (deployed, boot-validated) configuration, immediately before the first
 * issuance. Any problem refuses the issuance; nothing is written.
 */
export function checkLiveFirstIssueGate(
  config: ConfigGetter,
  ctx: { studioId: string; firstIssueUserId: string; credentialedUserIds: readonly string[] },
): string[] {
  const problems: string[] = [];
  const get = (key: string) => config.get<string>(key);
  if (get(WALLET_AUTO_ENROLL_ENABLED) !== 'true') problems.push('AUTO_ENROLL_NOT_ENABLED');
  if (get('WALLET_DYNAMIC_PASSES_ENABLED') !== 'true') problems.push('DYNAMIC_PASSES_DISABLED');
  if (get('WALLET_PASSKIT_ROUTES_ENABLED') !== 'true') problems.push('PASSKIT_ROUTES_DISABLED');
  if (get('WALLET_REFRESH_WORKER_ENABLED') === 'true') problems.push('REFRESH_WORKER_ENABLED');
  if (get(WALLET_AUTO_ENROLL_STUDIO_ID) !== ctx.studioId) problems.push('STUDIO_IS_NOT_THE_SYNTHETIC_STAGING_STUDIO');
  const raw = get(WALLET_AUTO_ENROLL_USER_IDS) ?? '';
  if (raw.includes('*')) problems.push('WILDCARD_IN_ALLOWLIST');
  const ids = raw.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length !== 1 || ids[0] !== ctx.firstIssueUserId) problems.push('ALLOWLIST_IS_NOT_EXACTLY_THIS_MEMBER');
  if (get(WALLET_AUTO_ENROLL_STUDIO_CAP) !== FIRST_ISSUE_COHORT_CAP) problems.push('CAP_IS_NOT_1');
  if (ids.some((id) => ctx.credentialedUserIds.includes(id))) problems.push('ALLOWLIST_NAMES_A_USER_WITH_AN_EXISTING_CREDENTIAL');
  if (!isAutoEnrollmentEligible(config, ctx.studioId, ctx.firstIssueUserId)) problems.push('INTENDED_MEMBER_NOT_ELIGIBLE_AT_RUNTIME');
  return problems;
}
