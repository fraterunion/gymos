import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletPassMode, WalletPassPlatform } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppleWalletProvider } from '../apple/apple-wallet-provider.service';
import { APNS_PRODUCTION_HOST, apnsEnabled } from '../dynamic/wallet-dynamic-pass.config';
import { ApnsClient, type ApnsClientOptions } from './apns.client';
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
};

/**
 * Tells every device registered for ONE dynamic pass that it changed (APNs, empty payload);
 * Wallet then asks the PassKit service for changed serials and downloads the new pass.
 *
 * Off unless WALLET_APNS_ENABLED=true. Called explicitly (the operator CLI in Stage 1A) —
 * there is no background job. No transaction is held across the network calls; tokens APNs
 * reports as permanently invalid are deleted afterwards, one short statement each.
 */
@Injectable()
export class WalletPassPushService {
  private readonly logger = new Logger(WalletPassPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly appleProvider: AppleWalletProvider,
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
        walletCredential: { select: { studioId: true } },
        registrations: {
          select: { id: true, pushToken: true, passTypeIdentifier: true },
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
    };
    if (artifact.registrations.length === 0) {
      this.logSummary(artifact.walletCredential.studioId, summary);
      return summary;
    }

    const client = new ApnsClient({
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
    this.logSummary(artifact.walletCredential.studioId, summary);
    return summary;
  }

  private logSummary(studioId: string, summary: WalletPassPushSummary): void {
    this.logger.log(JSON.stringify({ event: 'wallet.apns.pass_update', studioId, ...summary }));
  }
}
