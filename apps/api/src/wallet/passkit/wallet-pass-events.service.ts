import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WalletPassEventType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WALLET_REGISTRATION_CHURN_WINDOW_MS } from '../refresh/wallet-refresh.constants';

/** 16-hex SHA-256 prefix of a device library identifier (logs show its first 12 chars). */
export function deviceHashOf(deviceLibraryIdentifier: string): string {
  return createHash('sha256').update(deviceLibraryIdentifier).digest('hex').slice(0, 16);
}

/** Only these keys may appear in an event's detail object; values are numbers, booleans or short strings. */
const ALLOWED_DETAIL_KEYS = new Set([
  'outcome',
  'pushTokenChanged',
  'removed',
  'registrationAgeMs',
  'bytes',
  'ifModifiedSince',
  'apnsId',
  'reason',
  'pruned',
  'listed',
  'sinceTag',
]);

function safeDetail(detail: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  if (!detail) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!ALLOWED_DETAIL_KEYS.has(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, 64);
  }
  return out;
}

export type WalletPassEventInput = {
  studioId: string;
  walletPassArtifactId: string;
  walletCredentialId: string;
  type: WalletPassEventType;
  deviceLibraryIdentifier?: string | null;
  passVersion?: number | null;
  httpStatus?: number | null;
  detail?: Record<string, unknown>;
  occurredAt?: Date;
};

/** Finding code and the exact wording for a pass with zero registrations (never "removed"). */
export const NO_ACTIVE_UPDATE_REGISTRATION = 'NO_ACTIVE_UPDATE_REGISTRATION';
export const NO_ACTIVE_UPDATE_REGISTRATION_TEXT =
  'no active update registration: no device is currently registered to receive updates for this pass. This does not mean the pass was removed from Wallet — Wallet can drop a registration while keeping the pass installed.';

export type PassEventRow = {
  type: WalletPassEventType;
  deviceHash: string | null;
  passVersion: number | null;
  httpStatus: number | null;
  occurredAt: Date;
};

export type RegistrationHistoryAnalysis = {
  lastRegisteredAt: Date | null;
  lastUnregisteredAt: Date | null;
  lastApnsAcceptedAt: Date | null;
  lastApnsFailureAt: Date | null;
  lastPassRetrievedAt: Date | null;
  lastPassRetrievedVersion: number | null;
  lastNotModifiedAt: Date | null;
  /** Last time a registered device asked which passes changed and was told about this one. */
  lastSerialsListedAt: Date | null;
  /** A device fetched the current passVersion with a 200 at or after the content changed. */
  currentVersionRetrieved: boolean;
  /** Devices that unregistered soon after registering and have no active registration now. */
  churnSuspectedDevices: string[];
  findings: string[];
};

/**
 * Pure: derives the diagnostic view of one pass from its events (oldest first) and its current
 * registrations. Deliberately cautious: absence of registrations is reported as "no active
 * registration", never as "uninstalled" — Wallet can drop a registration while keeping the pass.
 */
export function analyzeRegistrationHistory(
  events: readonly PassEventRow[],
  activeDeviceHashes: readonly string[],
  current: { passVersion: number; lastModifiedAt: Date | null },
): RegistrationHistoryAnalysis {
  const last = (type: WalletPassEventType) =>
    [...events].reverse().find((e) => e.type === type) ?? null;
  const retrieved = last(WalletPassEventType.PASS_RETRIEVED);
  const active = new Set(activeDeviceHashes);

  const churn = new Set<string>();
  const lastRegisteredByDevice = new Map<string, Date>();
  for (const e of events) {
    if (!e.deviceHash) continue;
    if (e.type === WalletPassEventType.REGISTERED) lastRegisteredByDevice.set(e.deviceHash, e.occurredAt);
    if (e.type === WalletPassEventType.UNREGISTERED) {
      const registeredAt = lastRegisteredByDevice.get(e.deviceHash);
      if (registeredAt && e.occurredAt.getTime() - registeredAt.getTime() <= WALLET_REGISTRATION_CHURN_WINDOW_MS) {
        churn.add(e.deviceHash);
      }
    }
  }
  const churnSuspectedDevices = [...churn].filter((d) => !active.has(d));

  const currentVersionRetrieved = events.some(
    (e) =>
      e.type === WalletPassEventType.PASS_RETRIEVED &&
      e.passVersion === current.passVersion &&
      (current.lastModifiedAt === null || e.occurredAt >= current.lastModifiedAt),
  );

  const findings: string[] = [];
  if (active.size === 0) {
    findings.push(`${NO_ACTIVE_UPDATE_REGISTRATION}: ${NO_ACTIVE_UPDATE_REGISTRATION_TEXT}`);
  }
  if (churnSuspectedDevices.length > 0) {
    findings.push(
      'REGISTRATION_CHURN: a device unregistered within minutes of registering and has not re-registered — the pattern observed after an in-place static-to-dynamic replacement. Ask the member to open the pass (re-registration was observed on open); do not recreate registrations server-side.',
    );
  }
  if (!currentVersionRetrieved && current.passVersion > 0 && active.size > 0) {
    findings.push('CURRENT_VERSION_NOT_YET_RETRIEVED: registered devices have not downloaded the latest pass version.');
  }

  return {
    lastRegisteredAt: last(WalletPassEventType.REGISTERED)?.occurredAt ?? null,
    lastUnregisteredAt: last(WalletPassEventType.UNREGISTERED)?.occurredAt ?? null,
    lastApnsAcceptedAt: last(WalletPassEventType.APNS_ACCEPTED)?.occurredAt ?? null,
    lastApnsFailureAt:
      [...events].reverse().find((e) => e.type === WalletPassEventType.APNS_FAILED || e.type === WalletPassEventType.APNS_INVALID_TOKEN)
        ?.occurredAt ?? null,
    lastPassRetrievedAt: retrieved?.occurredAt ?? null,
    lastPassRetrievedVersion: retrieved?.passVersion ?? null,
    lastNotModifiedAt: last(WalletPassEventType.PASS_NOT_MODIFIED)?.occurredAt ?? null,
    lastSerialsListedAt: last(WalletPassEventType.SERIALS_LISTED)?.occurredAt ?? null,
    currentVersionRetrieved,
    churnSuspectedDevices,
    findings,
  };
}

/**
 * Pure: registered devices that have not asked Wallet's "which passes changed?" question about
 * this pass since they were notified of `passVersion`. An APNs 200 proves only that Apple accepted
 * the notification; a SERIALS_LISTED event from the device proves Wallet on that device acted on it.
 *
 * Each device is measured from ITS OWN latest APNs acceptance of `passVersion` — with several
 * devices and a retry, a device accepted on the first attempt usually lists its passes before the
 * retry finishes — and from `fallbackSince` (the pass's last push) only when no acceptance of that
 * version is recorded for it. Devices returned here may still be showing the previous version.
 */
export function devicesNotListedSince(
  events: readonly PassEventRow[],
  activeDeviceHashes: readonly string[],
  fallbackSince: Date,
  passVersion?: number,
): string[] {
  const acceptedAt = new Map<string, number>();
  const listedAt = new Map<string, number[]>();
  for (const e of events) {
    if (e.deviceHash === null) continue;
    const t = e.occurredAt.getTime();
    if (e.type === WalletPassEventType.APNS_ACCEPTED && passVersion !== undefined && e.passVersion === passVersion) {
      acceptedAt.set(e.deviceHash, Math.max(acceptedAt.get(e.deviceHash) ?? 0, t));
    } else if (e.type === WalletPassEventType.SERIALS_LISTED) {
      const list = listedAt.get(e.deviceHash) ?? [];
      list.push(t);
      listedAt.set(e.deviceHash, list);
    }
  }
  return activeDeviceHashes.filter((device) => {
    const since = acceptedAt.get(device) ?? fallbackSince.getTime();
    return !(listedAt.get(device) ?? []).some((t) => t >= since);
  });
}

/**
 * Append-only pass lifecycle history (Smart Wallet 2.0 Stage 3). Writes are best-effort: a
 * history insert can never fail or slow down a device request beyond one INSERT, and failures
 * are logged. Never stores a raw device identifier, push token, authentication token or QR value.
 */
@Injectable()
export class WalletPassEventsService {
  private readonly logger = new Logger(WalletPassEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: WalletPassEventInput): Promise<void> {
    try {
      await this.prisma.walletPassEvent.create({
        data: {
          studioId: input.studioId,
          walletPassArtifactId: input.walletPassArtifactId,
          walletCredentialId: input.walletCredentialId,
          type: input.type,
          deviceHash: input.deviceLibraryIdentifier ? deviceHashOf(input.deviceLibraryIdentifier) : null,
          passVersion: input.passVersion ?? null,
          httpStatus: input.httpStatus ?? null,
          detail: safeDetail(input.detail),
          ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        },
      });
    } catch (e) {
      this.logger.warn(
        JSON.stringify({
          event: 'wallet.pass_event.record_failed',
          type: input.type,
          walletCredentialId: input.walletCredentialId,
          error: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
        }),
      );
    }
  }
}
