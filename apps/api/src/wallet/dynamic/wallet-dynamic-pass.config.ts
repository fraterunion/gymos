import type { ConfigService } from '@nestjs/config';

/**
 * Smart Wallet 2.0 feature flags. Every flag defaults OFF (validateEnv normalizes each to the
 * string 'true' or 'false'); only the exact value 'true' turns a capability on.
 *
 * WALLET_DYNAMIC_PASSES_ENABLED   — may the server build/enroll DYNAMIC Apple passes at all.
 * WALLET_PASSKIT_ROUTES_ENABLED   — do the PassKit web service routes answer (404 otherwise).
 * WALLET_APNS_ENABLED             — may the server send APNs pushes for pass updates.
 * WALLET_PASSKIT_WEB_SERVICE_URL  — webServiceURL baked into dynamic passes; must point at
 *                                   this API's PassKit controller (".../api/v1/wallet/passkit").
 *
 * The APNs host is not configurable: Wallet pass-update pushes are only delivered by the
 * production APNs environment (api.push.apple.com).
 */
export const WALLET_DYNAMIC_PASSES_ENABLED = 'WALLET_DYNAMIC_PASSES_ENABLED';
export const WALLET_PASSKIT_ROUTES_ENABLED = 'WALLET_PASSKIT_ROUTES_ENABLED';
export const WALLET_APNS_ENABLED = 'WALLET_APNS_ENABLED';
export const WALLET_PASSKIT_WEB_SERVICE_URL = 'WALLET_PASSKIT_WEB_SERVICE_URL';

export const WALLET_PASSKIT_ROUTE_BASE = 'wallet/passkit';
export const APNS_PRODUCTION_HOST = 'api.push.apple.com';

export function isFlagOn(config: Pick<ConfigService, 'get'>, key: string): boolean {
  return config.get<string>(key) === 'true';
}

export function dynamicPassesEnabled(config: Pick<ConfigService, 'get'>): boolean {
  return isFlagOn(config, WALLET_DYNAMIC_PASSES_ENABLED);
}

export function passkitRoutesEnabled(config: Pick<ConfigService, 'get'>): boolean {
  return isFlagOn(config, WALLET_PASSKIT_ROUTES_ENABLED);
}

export function apnsEnabled(config: Pick<ConfigService, 'get'>): boolean {
  return isFlagOn(config, WALLET_APNS_ENABLED);
}

/** The configured webServiceURL, or null when absent (validateEnv already normalized it). */
export function passkitWebServiceUrl(config: Pick<ConfigService, 'get'>): string | null {
  const v = config.get<string>(WALLET_PASSKIT_WEB_SERVICE_URL);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
