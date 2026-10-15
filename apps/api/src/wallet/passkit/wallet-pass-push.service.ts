import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletPassEventType, WalletPassMode, WalletPassPlatform } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppleWalletProvider } from '../apple/apple-wallet-provider.service';
import { APNS_PRODUCTION_HOST, apnsEnabled } from '../dynamic/wallet-dynamic-pass.config';
import { ApnsClientFactory, type ApnsClientOptions } from './apns.client';
import { WalletPassEventsService } from './wallet-pass-events.service';
import { MAX_REGISTRATIONS_PER_PASS } from './passkit.service';

export class WalletPassPushError extends Error {
  constructor(readonly code: 'WALLET_APNS_DISABLED' | 'WALLET_APPLE_NOT_CONFIGURED' | 'WALLET_DYNAMIC_NOT_ENROLLED') {
    super(code);
    this.name = 'WalletPassPushError';
  }
}

export type WalletPassPushSummary = {
  walletCredentialId: string;
  registrations: number;
  delivered: number;
  failed: number;
  invalidTokensRemoved: number;
  failureReasons: string[];
  /** One entry per registration pushed: registration row id + APNs outcome. No push tokens. */
  results: Array<{ registrationId: string; ok: boolean; status: number | null; reason: string | null; apnsId: string | null; tokenInvalid: boolean }>;
  /** The passVersion this push announced, and whether it is now recorded as delivered. */
  passVersion: number;
  versionRecordedAsPushed: boolean;
};

/**
 * Tells every device registered for ONE dynamic pass that it changed (APNs, empty payload);
 * Wallet then asks the PassKit service for changed serials and downloads the new pass.
 *
 * Off unless WALLET_APNS_ENABLED=true. Called by the operator CLI and by the Stage 3 refresh
 * worker. No transaction is held across the network calls; tokens APNs reports as permanently
 * invalid are deleted afterwards, one short statement each.
 *
 * Delivery bookkeeping: when no registration failed transiently, the artifact's
 * pushedPassVersion advances to the passVersion read at the start (guarded, so a newer version
 * written meanwhile stays "unpushed"). A transient failure leaves it behind, so the refresh
 * worker retries the push; a pass whose content did not change is never pushed again.
 */
@Injectable()
export class WalletPassPushService {
  private readonly logger = new Logger(WalletPassPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly appleProvider: AppleWalletProvider,
    private readonly clients: ApnsClientFactory,
    private readonly events: WalletPassEventsService,
  ) {}

  isEnabled(): boolean {
    return apnsEnabled(this.config);
  }

  /**
   * `clientOverrides` exists for tests against a local HTTP/2 server (host + trust anchor);
   * production callers never pass it, so production pushes always go to api.push.apple.com.
   */
  async pushPassUpdate(walletCredentialId: string, clientOverrides: Partial<ApnsClientOptions> = {}): Promise<WalletPassPushSummary> {
    if (!this.isEnabled()) throw new WalletPassPushError('WALLET_APNS_DISABLED');
    if (!this.appleProvider.isConfigured()) throw new WalletPassPushError('WALLET_APPLE_NOT_CONFIGURED');

    const artifact = await this.prisma.walletPassArtifact.findUnique({
      where: { walletCredentialId_platform: { walletCredentialId, platform: WalletPassPlatform.APPLE } },
      select: {
        id: true,
        passMode: true,
        passVersion: true,
        walletCredential: { select: { studioId: true } },
        registrations: {
          select: { id: true, pushToken: true, passTypeIdentifier: true, deviceLibraryIdentifier: true },
          orderBy: { createdAt: 'asc' },
          take: MAX_REGISTRATIONS_PER_PASS,
        },
      },
    });
    if (!artifact || artifact.passMode !== WalletPassMode.DYNAMIC) {
      throw new WalletPassPushError('WALLET_DYNAMIC_NOT_ENROLLED');
    }

    const identity = this.appleProvider.apnsClientIdentity();
    const summary: WalletPassPushSummary = {
      walletCredentialId,
      registrations: artifact.registrations.length,
      delivered: 0,
      failed: 0,
      invalidTokensRemoved: 0,
      failureReasons: [],
      results: [],
      passVersion: artifact.passVersion,
      versionRecordedAsPushed: false,
    };
    const studioId = artifact.walletCredential.studioId;
    if (artifact.registrations.length === 0) {
      // Nothing to notify: a device that registers later downloads the current pass anyway.
      summary.versionRecordedAsPushed = await this.recordPushed(artifact.id, artifact.passVersion);
      this.logSummary(studioId, summary);
      return summary;
    }

    const client = this.clients.create({
      host: APNS_PRODUCTION_HOST,
      certPem: identity.certPem,
      keyPem: identity.keyPem,
      ...clientOverrides,
    });
    const invalidRegistrationIds: string[] = [];
    try {
      for (const registration of artifact.registrations) {
        // A registration only exists for the configured pass type (checked at registration).
        const result = await client.sendPassUpdate(registration.pushToken, identity.passTypeIdentifier);
        const tokenInvalid = !result.ok && result.tokenInvalid;
        summary.results.push({
          registrationId: registration.id,
          ok: result.ok,
          status: result.status,
          reason: result.ok ? null : result.reason,
          apnsId: result.apnsId,
          tokenInvalid,
        });
        await this.events.record({
          studioId,
          walletPassArtifactId: artifact.id,
          walletCredentialId,
          type: result.ok
            ? WalletPassEventType.APNS_ACCEPTED
            : tokenInvalid
              ? WalletPassEventType.APNS_INVALID_TOKEN
              : WalletPassEventType.APNS_FAILED,
          deviceLibraryIdentifier: registration.deviceLibraryIdentifier,
          passVersion: artifact.passVersion,
          httpStatus: result.status,
          detail: { apnsId: result.apnsId, reason: result.ok ? null : result.reason, pruned: tokenInvalid },
        });
        if (result.ok) {
          summary.delivered += 1;
          continue;
        }
        summary.failed += 1;
        summary.failureReasons.push(`${result.status ?? 'none'}:${result.reason ?? 'unknown'}`);
        if (result.tokenInvalid) invalidRegistrationIds.push(registration.id);
      }
    } finally {
      client.close();
    }

    if (invalidRegistrationIds.length > 0) {
      const { count } = await this.prisma.walletPassRegistration.deleteMany({
        where: { id: { in: invalidRegistrationIds }, walletPassArtifactId: artifact.id },
      });
      summary.invalidTokensRemoved = count;
    }
    const transientFailures = summary.results.filter((r) => !r.ok && !r.tokenInvalid).length;
    if (transientFailures === 0) {
      summary.versionRecordedAsPushed = await this.recordPushed(artifact.id, artifact.passVersion);
    }
    this.logSummary(studioId, summary);
    return summary;
  }

  /** Guarded: only advances, and only if the pass is still at the version that was pushed. */
  private async recordPushed(artifactId: string, passVersion: number): Promise<boolean> {
    const { count } = await this.prisma.walletPassArtifact.updateMany({
      where: { id: artifactId, passVersion, pushedPassVersion: { lt: passVersion } },
      data: { pushedPassVersion: passVersion, lastPushedAt: new Date() },
    });
    return count === 1;
  }

  private logSummary(studioId: string, summary: WalletPassPushSummary): void {
    this.logger.log(JSON.stringify({ event: 'wallet.apns.pass_update', studioId, ...summary }));
  }
}
