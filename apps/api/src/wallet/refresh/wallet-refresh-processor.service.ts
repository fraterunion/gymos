import { Injectable, Logger } from '@nestjs/common';
import { WalletPassMode, WalletPassPlatform } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletDynamicPassError, WalletDynamicPassService, type WalletDynamicPassErrorCode } from '../dynamic/wallet-dynamic-pass.service';
import { WalletPassPushError, WalletPassPushService } from '../passkit/wallet-pass-push.service';
import { sanitizeRefreshError } from './wallet-refresh-queue.service';

/** Retry with backoff (transient: races, configuration momentarily absent, APNs/network trouble). */
export class WalletRefreshRetryableError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WalletRefreshRetryableError';
  }
}

/** Dead-letter immediately: retrying cannot help and must not be attempted blindly. */
export class WalletRefreshPermanentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WalletRefreshPermanentError';
  }
}

/** Integrity failures: the stored pass cannot prove its own token/QR — never rotate, never retry. */
const PERMANENT_CODES = new Set<WalletDynamicPassErrorCode>([
  'WALLET_DYNAMIC_TOKEN_UNRECOVERABLE',
  'WALLET_DYNAMIC_BARCODE_UNRECOVERABLE',
]);
/** The artifact is no longer something this job should touch. */
const SKIP_CODES = new Set<WalletDynamicPassErrorCode>([
  'WALLET_DYNAMIC_NOT_ENROLLED',
  'WALLET_DYNAMIC_ARTIFACT_NOT_FOUND',
  'WALLET_DYNAMIC_CREDENTIAL_NOT_FOUND',
]);

/**
 * Processes one refresh job: recompute every DYNAMIC Apple pass the member holds in the studio
 * (their current credential and any revoked one, so a reissue voids the old pass), then push
 * each pass whose content version has not been delivered yet. All side effects are the existing,
 * idempotent primitives: WalletDynamicPassService.refresh (content-hash guarded, optimistic
 * write) and WalletPassPushService.pushPassUpdate (version-guarded bookkeeping). Running the
 * same job twice changes nothing the second time and sends no second push.
 *
 * Reads entitlement data only; never writes subscriptions, payments, cycles or credentials.
 */
@Injectable()
export class WalletRefreshProcessorService {
  private readonly logger = new Logger(WalletRefreshProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dynamic: WalletDynamicPassService,
    private readonly push: WalletPassPushService,
  ) {}

  async processMember(target: { studioId: string; userId: string }, now: Date): Promise<string> {
    const artifacts = await this.prisma.walletPassArtifact.findMany({
      where: {
        platform: WalletPassPlatform.APPLE,
        passMode: WalletPassMode.DYNAMIC,
        walletCredential: { studioId: target.studioId, userId: target.userId },
      },
      select: { walletCredentialId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (artifacts.length === 0) return 'no_dynamic_pass';

    const parts: string[] = [];
    for (const { walletCredentialId } of artifacts) {
      let refreshed: string;
      try {
        refreshed = (await this.dynamic.refresh(walletCredentialId, now)).outcome;
      } catch (e) {
        if (e instanceof WalletDynamicPassError) {
          if (PERMANENT_CODES.has(e.code)) throw new WalletRefreshPermanentError(e.code);
          if (SKIP_CODES.has(e.code)) {
            parts.push(`${walletCredentialId}:skipped:${e.code}`);
            continue;
          }
          throw new WalletRefreshRetryableError(e.code);
        }
        // Rendering/signing failure (e.g. certificate or asset problem): monitored, retried.
        const error = sanitizeRefreshError(e);
        this.logger.error(JSON.stringify({ event: 'wallet.refresh.build_failed', studioId: target.studioId, walletCredentialId, error }));
        throw new WalletRefreshRetryableError(`BUILD_FAILED:${error}`);
      }
      const pushed = await this.pushIfUndelivered(walletCredentialId);
      parts.push(`${walletCredentialId}:${refreshed}:${pushed}`);
    }
    return parts.join(' ');
  }

  /** Push only a content version devices have not been told about. */
  private async pushIfUndelivered(walletCredentialId: string): Promise<string> {
    const artifact = await this.prisma.walletPassArtifact.findUnique({
      where: { walletCredentialId_platform: { walletCredentialId, platform: WalletPassPlatform.APPLE } },
      select: { passVersion: true, pushedPassVersion: true },
    });
    if (!artifact || artifact.passVersion <= artifact.pushedPassVersion) return 'no_push_needed';
    if (!this.push.isEnabled()) return 'push_pending_apns_disabled';
    let summary;
    try {
      summary = await this.push.pushPassUpdate(walletCredentialId, {}, { skipDevicesAlreadyAccepted: true });
    } catch (e) {
      if (e instanceof WalletPassPushError) throw new WalletRefreshRetryableError(e.code);
      throw new WalletRefreshRetryableError(`APNS_ERROR:${sanitizeRefreshError(e)}`);
    }
    const transient = summary.results.filter((r) => !r.ok && !r.tokenInvalid);
    if (transient.length > 0) {
      throw new WalletRefreshRetryableError(`APNS_TRANSIENT:${transient.map((r) => `${r.status ?? 'none'}:${r.reason ?? 'unknown'}`).join(',')}`);
    }
    if (summary.registrations === 0) return 'no_registrations';
    return summary.alreadyAccepted > 0 ? `pushed:${summary.delivered},already:${summary.alreadyAccepted}` : `pushed:${summary.delivered}`;
  }
}
