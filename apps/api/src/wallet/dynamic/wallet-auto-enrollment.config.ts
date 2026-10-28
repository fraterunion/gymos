import type { ConfigService } from '@nestjs/config';

/**
 * Stage 4B: one studio and an explicit bounded cohort per deployment.
 * This is deliberately NOT a switch that automatically migrates previously issued passes.
 */
export const WALLET_AUTO_ENROLL_ENABLED = 'WALLET_AUTO_ENROLL_ENABLED';
export const WALLET_AUTO_ENROLL_STUDIO_ID = 'WALLET_AUTO_ENROLL_STUDIO_ID';
export const WALLET_AUTO_ENROLL_USER_IDS = 'WALLET_AUTO_ENROLL_USER_IDS';
export const WALLET_AUTO_ENROLL_STUDIO_CAP = 'WALLET_AUTO_ENROLL_STUDIO_CAP';

export function normalizeAutoEnrollFlag(value: unknown): string {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true' ? 'true' : 'false';
}

export function validateAutoEnrollmentEnv(out: Record<string, unknown>): void {
  out[WALLET_AUTO_ENROLL_ENABLED] = normalizeAutoEnrollFlag(out[WALLET_AUTO_ENROLL_ENABLED]);
  if (out[WALLET_AUTO_ENROLL_ENABLED] !== 'true') return;

  if (out['WALLET_DYNAMIC_PASSES_ENABLED'] !== 'true' || out['WALLET_PASSKIT_ROUTES_ENABLED'] !== 'true') {
    throw new Error('Wallet Stage 4B requires both dynamic passes and PassKit routes enabled');
  }
  const studioId = out[WALLET_AUTO_ENROLL_STUDIO_ID];
  const rawIds = out[WALLET_AUTO_ENROLL_USER_IDS];
  const rawCap = out[WALLET_AUTO_ENROLL_STUDIO_CAP];
  if (typeof studioId !== 'string' || !/^[a-zA-Z0-9_-]{4,128}$/.test(studioId.trim())) {
    throw new Error('Wallet Stage 4B requires a single valid studio id');
  }
  if (typeof rawIds !== 'string' || !rawIds.trim() || rawIds.includes('*')) {
    throw new Error('Wallet Stage 4B requires explicit user IDs, never a wildcard');
  }
  const ids = rawIds.split(',').map((id) => id.trim());
  if (ids.some((id) => !/^[a-zA-Z0-9_-]{4,128}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Wallet Stage 4B requires unique, valid user IDs');
  }
  const cap = typeof rawCap === 'string' && /^\d+$/.test(rawCap) ? Number(rawCap) : NaN;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 200 || ids.length > cap) {
    throw new Error('Wallet Stage 4B allowlist exceeds the configured 1–200 member cohort cap');
  }
  out[WALLET_AUTO_ENROLL_STUDIO_ID] = studioId.trim();
  out[WALLET_AUTO_ENROLL_USER_IDS] = ids.join(',');
  out[WALLET_AUTO_ENROLL_STUDIO_CAP] = String(cap);
}

/** No wildcard or studio-wide fallback: unknown or absent values always deny. */
export function isAutoEnrollmentEligible(
  config: Pick<ConfigService, 'get'>,
  studioId: string,
  userId: string,
): boolean {
  if (config.get<string>(WALLET_AUTO_ENROLL_ENABLED) !== 'true') return false;
  const configuredStudio = config.get<string>(WALLET_AUTO_ENROLL_STUDIO_ID);
  const rawIds = config.get<string>(WALLET_AUTO_ENROLL_USER_IDS);
  const rawCap = config.get<string>(WALLET_AUTO_ENROLL_STUDIO_CAP);
  if (!configuredStudio || configuredStudio !== studioId || !rawIds || !rawCap) return false;
  const ids = rawIds.split(',').map((id) => id.trim());
  const cap = Number(rawCap);
  if (!Number.isSafeInteger(cap) || cap < 1 || ids.length > cap) return false;
  return ids.includes(userId);
}
