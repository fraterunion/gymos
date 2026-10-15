import { Injectable } from '@nestjs/common';
import { WalletPassMode, WalletPassPlatform, WalletPassRefreshStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppleWalletProvider } from '../apple/apple-wallet-provider.service';
import { analyzeRegistrationHistory, deviceHashOf, type PassEventRow } from '../passkit/wallet-pass-events.service';
import { certificateExpiryLevel } from './wallet-refresh.constants';

const EVENT_WINDOW = 500;
const STUDIO_EVENT_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const CAVEAT =
  'Registrations are created and removed only by devices. Zero registrations means no device is currently registered for updates; it does not prove the pass was removed from the Wallet.';

/**
 * Read-only operator diagnostics (Smart Wallet 2.0 Stage 3). Never prints raw device
 * identifiers, push tokens, authentication tokens or QR values: devices appear as the same
 * 16-hex hash the event history stores, push tokens only as their length.
 */
@Injectable()
export class WalletDiagnosticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly appleProvider: AppleWalletProvider,
  ) {}

  async passReport(walletCredentialId: string, recentEventCount = 30) {
    const artifact = await this.prisma.walletPassArtifact.findUnique({
      where: { walletCredentialId_platform: { walletCredentialId, platform: WalletPassPlatform.APPLE } },
      select: {
        id: true,
        passMode: true,
        passVersion: true,
        pushedPassVersion: true,
        lastPushedAt: true,
        lastModifiedAt: true,
        nextTransitionAt: true,
        dynamicTemplateVersion: true,
        dynamicEnabledAt: true,
        walletCredential: { select: { studioId: true, userId: true, revokedAt: true } },
        registrations: {
          select: { deviceLibraryIdentifier: true, pushToken: true, createdAt: true, updatedAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!artifact) return { walletCredentialId, found: false as const };

    const newestFirst = await this.prisma.walletPassEvent.findMany({
      where: { walletPassArtifactId: artifact.id },
      orderBy: { occurredAt: 'desc' },
      take: EVENT_WINDOW,
      select: { type: true, deviceHash: true, passVersion: true, httpStatus: true, occurredAt: true, detail: true },
    });
    const events = [...newestFirst].reverse();
    const registrations = artifact.registrations.map((r) => ({
      device: deviceHashOf(r.deviceLibraryIdentifier),
      pushTokenLength: r.pushToken.length,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    const analysis = analyzeRegistrationHistory(events as PassEventRow[], registrations.map((r) => r.device), {
      passVersion: artifact.passVersion,
      lastModifiedAt: artifact.lastModifiedAt,
    });
    const recentJobs = await this.prisma.walletPassRefreshJob.findMany({
      where: { studioId: artifact.walletCredential.studioId, userId: artifact.walletCredential.userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, status: true, reason: true, attempts: true, triggerCount: true, runAfter: true, completedAt: true, outcome: true, lastError: true },
    });

    return {
      walletCredentialId,
      found: true as const,
      studioId: artifact.walletCredential.studioId,
      credentialRevoked: artifact.walletCredential.revokedAt !== null,
      passMode: artifact.passMode,
      passVersion: artifact.passVersion,
      pushedPassVersion: artifact.pushedPassVersion,
      undeliveredVersion: artifact.passMode === WalletPassMode.DYNAMIC && artifact.passVersion > artifact.pushedPassVersion,
      lastPushedAt: artifact.lastPushedAt,
      lastModifiedAt: artifact.lastModifiedAt,
      nextTransitionAt: artifact.nextTransitionAt,
      dynamicTemplateVersion: artifact.dynamicTemplateVersion,
      dynamicEnabledAt: artifact.dynamicEnabledAt,
      activeDeviceCount: registrations.length,
      registrations,
      ...analysis,
      recentEvents: newestFirst.slice(0, recentEventCount).map((e) => ({
        at: e.occurredAt,
        type: e.type,
        device: e.deviceHash,
        passVersion: e.passVersion,
        httpStatus: e.httpStatus,
        detail: e.detail,
      })),
      recentJobs,
      caveat: CAVEAT,
    };
  }

  async studioReport(studioId: string, now: Date) {
    const artifacts = await this.prisma.walletPassArtifact.findMany({
      where: { passMode: WalletPassMode.DYNAMIC, platform: WalletPassPlatform.APPLE, walletCredential: { studioId } },
      select: {
        id: true,
        walletCredentialId: true,
        passVersion: true,
        pushedPassVersion: true,
        lastModifiedAt: true,
        nextTransitionAt: true,
        walletCredential: { select: { revokedAt: true } },
        registrations: { select: { deviceLibraryIdentifier: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const events = await this.prisma.walletPassEvent.findMany({
      where: { studioId, walletPassArtifactId: { in: artifacts.map((a) => a.id) }, occurredAt: { gt: new Date(now.getTime() - STUDIO_EVENT_LOOKBACK_MS) } },
      orderBy: { occurredAt: 'asc' },
      select: { walletPassArtifactId: true, type: true, deviceHash: true, passVersion: true, httpStatus: true, occurredAt: true },
    });
    const byArtifact = new Map<string, PassEventRow[]>();
    for (const e of events) {
      const list = byArtifact.get(e.walletPassArtifactId) ?? [];
      list.push(e);
      byArtifact.set(e.walletPassArtifactId, list);
    }

    const passes = artifacts.map((a) => {
      const devices = a.registrations.map((r) => deviceHashOf(r.deviceLibraryIdentifier));
      const analysis = analyzeRegistrationHistory(byArtifact.get(a.id) ?? [], devices, { passVersion: a.passVersion, lastModifiedAt: a.lastModifiedAt });
      return {
        walletCredentialId: a.walletCredentialId,
        credentialRevoked: a.walletCredential.revokedAt !== null,
        passVersion: a.passVersion,
        undeliveredVersion: a.passVersion > a.pushedPassVersion,
        activeDeviceCount: devices.length,
        lastRegisteredAt: analysis.lastRegisteredAt,
        lastUnregisteredAt: analysis.lastUnregisteredAt,
        lastApnsAcceptedAt: analysis.lastApnsAcceptedAt,
        lastPassRetrievedAt: analysis.lastPassRetrievedAt,
        currentVersionRetrieved: analysis.currentVersionRetrieved,
        churnSuspected: analysis.churnSuspectedDevices.length > 0,
        nextTransitionAt: a.nextTransitionAt,
      };
    });

    const jobGroups = await this.prisma.walletPassRefreshJob.groupBy({ by: ['status'], where: { studioId }, _count: { _all: true } });
    const oldestPending = await this.prisma.walletPassRefreshJob.findFirst({
      where: { studioId, status: WalletPassRefreshStatus.PENDING, runAfter: { lte: now } },
      orderBy: { runAfter: 'asc' },
      select: { runAfter: true },
    });

    return {
      studioId,
      at: now.toISOString(),
      dynamicPasses: passes.length,
      withActiveRegistration: passes.filter((p) => p.activeDeviceCount > 0).length,
      withoutActiveRegistration: passes.filter((p) => p.activeDeviceCount === 0).length,
      churnSuspected: passes.filter((p) => p.churnSuspected).length,
      undelivered: passes.filter((p) => p.undeliveredVersion).length,
      passes,
      queue: {
        byStatus: Object.fromEntries(jobGroups.map((g) => [g.status, g._count._all])),
        oldestDuePendingAgeMs: oldestPending ? now.getTime() - oldestPending.runAfter.getTime() : null,
      },
      caveat: CAVEAT,
    };
  }

  certificateReport(now: Date) {
    if (!this.appleProvider.isConfigured()) return { configured: false as const };
    const info = this.appleProvider.signingCertificateInfo();
    return {
      configured: true as const,
      passTypeIdentifier: info.passTypeIdentifier,
      teamIdentifier: info.teamIdentifier,
      notBefore: info.notBefore,
      notAfter: info.notAfter,
      ...certificateExpiryLevel(info.notAfter, now),
    };
  }
}
