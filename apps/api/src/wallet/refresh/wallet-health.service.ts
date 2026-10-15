import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletPassEventType, WalletPassMode, WalletPassPlatform, WalletPassRefreshStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppleWalletProvider } from '../apple/apple-wallet-provider.service';
import { apnsEnabled, dynamicPassesEnabled, refreshWorkerEnabled } from '../dynamic/wallet-dynamic-pass.config';
import {
  analyzeRegistrationHistory,
  deviceHashOf,
  devicesNotListedSince,
  NO_ACTIVE_UPDATE_REGISTRATION,
  NO_ACTIVE_UPDATE_REGISTRATION_TEXT,
  type PassEventRow,
} from '../passkit/wallet-pass-events.service';
import {
  certificateExpiryLevel,
  isRefreshFailureSpike,
  WALLET_HEALTH_APNS_PLATFORM_FAILURES_PER_HOUR,
  WALLET_HEALTH_APNS_REPEATED_FAILURES,
  WALLET_HEALTH_NEVER_REGISTERED_AFTER_MS,
  WALLET_HEALTH_NOT_LISTED_AFTER_MS,
  WALLET_HEALTH_QUEUE_BACKLOG_HIGH_MS,
  WALLET_HEALTH_QUEUE_BACKLOG_MEDIUM_MS,
  WALLET_HEALTH_UNDELIVERED_AFTER_MS,
  WALLET_HEALTH_WORKER_IDLE_MS,
  WALLET_REFRESH_LEASE_MS,
} from './wallet-refresh.constants';

/** Same vocabulary as billing reconciliation cases. */
export type WalletHealthSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
const SEVERITY_RANK: Record<WalletHealthSeverity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

export type WalletHealthCode =
  | 'DEAD_LETTER_JOBS'
  | 'REFRESH_FAILURE_SPIKE'
  | 'APNS_REPEATED_FAILURES'
  | 'APNS_FAILURE_RATE'
  | typeof NO_ACTIVE_UPDATE_REGISTRATION
  | 'NEVER_REGISTERED_FOR_UPDATES'
  | 'UNDELIVERED_VERSION'
  | 'NOT_FETCHED_AFTER_PUSH'
  | 'QUEUE_BACKLOG'
  | 'STUCK_JOBS'
  | 'WORKER_IDLE'
  | 'CERTIFICATE_EXPIRY';

export type WalletHealthFinding = {
  code: WalletHealthCode;
  severity: WalletHealthSeverity;
  studioId: string | null;
  walletCredentialId: string | null;
  message: string;
  metrics: Record<string, string | number | boolean | null | string[]>;
};

export type WalletHealthReport = {
  at: string;
  studioId: string | null;
  flags: { dynamic: boolean; apns: boolean; worker: boolean };
  totals: { dynamicPasses: number; withActiveRegistration: number; undelivered: number; deadLetters24h: number; queuePendingDue: number; queueRunning: number };
  counts: Record<WalletHealthSeverity, number>;
  maxSeverity: WalletHealthSeverity | null;
  findings: WalletHealthFinding[];
};

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const HISTORY_LOOKBACK_MS = 30 * DAY;

/**
 * Smart Wallet 2.0 Stage 4A — read-only operational health of the dynamic-pass pipeline.
 *
 * Evaluated by the refresh worker every 15 minutes (structured `wallet.health.*` log lines, the
 * same channel the billing alerts use in their default log-only mode) and on demand by
 * `wallet-diagnostics.cli.js health` (suitable for a cron; exits 3 on HIGH/CRITICAL). It never
 * writes, never contacts Apple, and never sends an alert itself.
 *
 * Wording rules: a pass with zero registrations has "no active update registration" — never
 * "removed". An APNs 200 is "accepted by APNs", not "displayed": a device counts as having acted
 * on an update only when it asks for its changed passes afterwards (SERIALS_LISTED).
 */
@Injectable()
export class WalletHealthService {
  private readonly logger = new Logger(WalletHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly appleProvider: AppleWalletProvider,
  ) {}

  async evaluate(now: Date, opts: { studioId?: string } = {}): Promise<WalletHealthReport> {
    const studioId = opts.studioId ?? null;
    const flags = { dynamic: dynamicPassesEnabled(this.config), apns: apnsEnabled(this.config), worker: refreshWorkerEnabled(this.config) };
    const findings: WalletHealthFinding[] = [];
    const studioJobs = studioId ? { studioId } : {};

    // ---- passes ---------------------------------------------------------------------------
    const artifacts = await this.prisma.walletPassArtifact.findMany({
      where: { passMode: WalletPassMode.DYNAMIC, platform: WalletPassPlatform.APPLE, ...(studioId ? { walletCredential: { studioId } } : {}) },
      select: {
        id: true,
        walletCredentialId: true,
        passVersion: true,
        pushedPassVersion: true,
        lastPushedAt: true,
        lastModifiedAt: true,
        dynamicEnabledAt: true,
        walletCredential: { select: { studioId: true, revokedAt: true } },
        registrations: { select: { deviceLibraryIdentifier: true, createdAt: true } },
      },
    });
    const ids = artifacts.map((a) => a.id);
    const events = ids.length
      ? await this.prisma.walletPassEvent.findMany({
          where: { walletPassArtifactId: { in: ids }, occurredAt: { gt: new Date(now.getTime() - HISTORY_LOOKBACK_MS) } },
          orderBy: { occurredAt: 'asc' },
          select: { walletPassArtifactId: true, type: true, deviceHash: true, passVersion: true, httpStatus: true, occurredAt: true, detail: true },
        })
      : [];
    const everRegistered = new Set(
      ids.length
        ? (
            await this.prisma.walletPassEvent.groupBy({
              by: ['walletPassArtifactId'],
              where: { walletPassArtifactId: { in: ids }, type: WalletPassEventType.REGISTERED },
            })
          ).map((g) => g.walletPassArtifactId)
        : [],
    );
    const byArtifact = new Map<string, typeof events>();
    for (const e of events) {
      const list = byArtifact.get(e.walletPassArtifactId) ?? [];
      list.push(e);
      byArtifact.set(e.walletPassArtifactId, list);
    }

    let withActiveRegistration = 0;
    let undelivered = 0;
    for (const a of artifacts) {
      const rows = byArtifact.get(a.id) ?? [];
      const devices = a.registrations.map((r) => deviceHashOf(r.deviceLibraryIdentifier));
      const base = { studioId: a.walletCredential.studioId, walletCredentialId: a.walletCredentialId };
      const revoked = a.walletCredential.revokedAt !== null;
      if (devices.length > 0) withActiveRegistration += 1;

      // Repeated APNs failures for this pass, with no acceptance since the latest failure.
      const failures = rows.filter((e) => e.type === WalletPassEventType.APNS_FAILED && e.occurredAt.getTime() > now.getTime() - DAY);
      const lastFailure = failures.at(-1);
      const acceptedAfter = lastFailure ? rows.some((e) => e.type === WalletPassEventType.APNS_ACCEPTED && e.occurredAt >= lastFailure.occurredAt) : false;
      if (failures.length >= WALLET_HEALTH_APNS_REPEATED_FAILURES && !acceptedAfter) {
        const reason = (lastFailure?.detail as { reason?: unknown } | null)?.reason;
        findings.push({
          ...base,
          code: 'APNS_REPEATED_FAILURES',
          severity: 'HIGH',
          message: `APNs rejected or failed ${failures.length} update notifications for this pass in 24 h with no accepted notification since.`,
          metrics: { failures24h: failures.length, lastFailureAt: lastFailure!.occurredAt.toISOString(), lastReason: typeof reason === 'string' ? reason : null },
        });
      }

      if (revoked) continue; // a replaced credential's pass is expected to go quiet

      if (devices.length === 0) {
        if (everRegistered.has(a.id)) {
          const analysis = analyzeRegistrationHistory(rows as PassEventRow[], [], { passVersion: a.passVersion, lastModifiedAt: a.lastModifiedAt });
          findings.push({
            ...base,
            code: NO_ACTIVE_UPDATE_REGISTRATION,
            severity: 'MEDIUM',
            message: `${NO_ACTIVE_UPDATE_REGISTRATION_TEXT} Ask the member to open the pass in Wallet; never recreate registrations server-side.`,
            metrics: {
              lastRegisteredAt: analysis.lastRegisteredAt?.toISOString() ?? null,
              lastUnregisteredAt: analysis.lastUnregisteredAt?.toISOString() ?? null,
              churnSuspected: analysis.churnSuspectedDevices.length > 0,
            },
          });
        } else if (a.dynamicEnabledAt && now.getTime() - a.dynamicEnabledAt.getTime() > WALLET_HEALTH_NEVER_REGISTERED_AFTER_MS) {
          findings.push({
            ...base,
            code: 'NEVER_REGISTERED_FOR_UPDATES',
            severity: 'LOW',
            message: 'This dynamic pass has never had an update registration. The member may not have added this version to Wallet; it does not mean a pass was removed.',
            metrics: { dynamicEnabledAt: a.dynamicEnabledAt.toISOString() },
          });
        }
        continue;
      }

      if (a.passVersion > a.pushedPassVersion) {
        undelivered += 1;
        const waitingMs = a.lastModifiedAt ? now.getTime() - a.lastModifiedAt.getTime() : 0;
        if (waitingMs > WALLET_HEALTH_UNDELIVERED_AFTER_MS) {
          findings.push({
            ...base,
            code: 'UNDELIVERED_VERSION',
            severity: 'MEDIUM',
            message: flags.apns
              ? 'The newest version of this pass has not been accepted by APNs for every registered device; devices may still display an older version.'
              : 'The newest version of this pass is waiting for delivery because APNs is disabled; devices may still display an older version.',
            metrics: { passVersion: a.passVersion, pushedPassVersion: a.pushedPassVersion, waitingMinutes: Math.round(waitingMs / 60_000), apnsEnabled: flags.apns, devices: devices.length },
          });
        }
        continue;
      }

      // Delivered to APNs — but did each device that was registered at push time act on it?
      if (a.lastPushedAt && a.pushedPassVersion > 0 && now.getTime() - a.lastPushedAt.getTime() > WALLET_HEALTH_NOT_LISTED_AFTER_MS) {
        const registeredAtPush = a.registrations
          .filter((r) => r.createdAt.getTime() <= a.lastPushedAt!.getTime())
          .map((r) => deviceHashOf(r.deviceLibraryIdentifier));
        const silent = devicesNotListedSince(rows as PassEventRow[], registeredAtPush, a.lastPushedAt);
        if (silent.length > 0) {
          findings.push({
            ...base,
            code: 'NOT_FETCHED_AFTER_PUSH',
            severity: 'LOW',
            message:
              'APNs accepted the update notification, but these registered devices have not asked Wallet for changed passes since; they may still display the previous version. APNs acceptance is not proof of display.',
            metrics: { passVersion: a.passVersion, lastPushedAt: a.lastPushedAt.toISOString(), devicesNotFetched: silent, devicesRegisteredAtPush: registeredAtPush.length },
          });
        }
      }
    }

    // ---- queue and jobs -------------------------------------------------------------------
    const dayAgo = new Date(now.getTime() - DAY);
    const deadLetters = await this.prisma.walletPassRefreshJob.groupBy({
      by: ['studioId', 'lastError'],
      where: { ...studioJobs, status: WalletPassRefreshStatus.FAILED, completedAt: { gt: dayAgo } },
      _count: { _all: true },
    });
    const deadByStudio = new Map<string, { count: number; errors: string[] }>();
    for (const g of deadLetters) {
      const entry = deadByStudio.get(g.studioId) ?? { count: 0, errors: [] };
      entry.count += g._count._all;
      if (g.lastError && entry.errors.length < 3) entry.errors.push(g.lastError.slice(0, 80));
      deadByStudio.set(g.studioId, entry);
    }
    for (const [sid, entry] of deadByStudio) {
      findings.push({
        code: 'DEAD_LETTER_JOBS',
        severity: 'HIGH',
        studioId: sid,
        walletCredentialId: null,
        message: `${entry.count} pass refresh job(s) exhausted their retries or failed an integrity check in the last 24 h; the affected passes are not updating.`,
        metrics: { count: entry.count, errors: entry.errors },
      });
    }

    const failureWindow = async (from: Date, to: Date) =>
      this.prisma.walletPassRefreshJob.count({
        where: {
          ...studioJobs,
          lastError: { not: null },
          status: { in: [WalletPassRefreshStatus.PENDING, WalletPassRefreshStatus.FAILED] },
          updatedAt: { gt: from, lte: to },
        },
      });
    const lastHourFailures = await failureWindow(new Date(now.getTime() - HOUR), now);
    const previousDayFailures = await failureWindow(new Date(now.getTime() - 25 * HOUR), new Date(now.getTime() - HOUR));
    if (isRefreshFailureSpike(lastHourFailures, previousDayFailures)) {
      findings.push({
        code: 'REFRESH_FAILURE_SPIKE',
        severity: 'HIGH',
        studioId,
        walletCredentialId: null,
        message: 'Refresh failures in the last hour are well above the previous day’s hourly average.',
        metrics: { lastHour: lastHourFailures, previous24h: previousDayFailures },
      });
    }

    const apnsFailuresLastHour = await this.prisma.walletPassEvent.count({
      where: { ...(studioId ? { studioId } : {}), type: WalletPassEventType.APNS_FAILED, occurredAt: { gt: new Date(now.getTime() - HOUR) } },
    });
    if (apnsFailuresLastHour >= WALLET_HEALTH_APNS_PLATFORM_FAILURES_PER_HOUR) {
      findings.push({
        code: 'APNS_FAILURE_RATE',
        severity: 'HIGH',
        studioId,
        walletCredentialId: null,
        message: 'APNs is failing update notifications at an elevated rate (transient errors, throttling or a certificate problem).',
        metrics: { failuresLastHour: apnsFailuresLastHour },
      });
    }

    const pendingDue = await this.prisma.walletPassRefreshJob.count({ where: { ...studioJobs, status: WalletPassRefreshStatus.PENDING, runAfter: { lte: now } } });
    const oldestDue = await this.prisma.walletPassRefreshJob.findFirst({
      where: { ...studioJobs, status: WalletPassRefreshStatus.PENDING, runAfter: { lte: now } },
      orderBy: { runAfter: 'asc' },
      select: { runAfter: true },
    });
    const backlogMs = oldestDue ? now.getTime() - oldestDue.runAfter.getTime() : 0;
    if (backlogMs > WALLET_HEALTH_QUEUE_BACKLOG_MEDIUM_MS) {
      findings.push({
        code: 'QUEUE_BACKLOG',
        severity: backlogMs > WALLET_HEALTH_QUEUE_BACKLOG_HIGH_MS ? 'HIGH' : 'MEDIUM',
        studioId,
        walletCredentialId: null,
        message: 'Due pass refresh jobs are waiting longer than expected; the refresh worker may be stopped, disabled or overloaded.',
        metrics: { pendingDue, oldestWaitMinutes: Math.round(backlogMs / 60_000), workerEnabled: flags.worker },
      });
    }

    const running = await this.prisma.walletPassRefreshJob.count({ where: { ...studioJobs, status: WalletPassRefreshStatus.RUNNING } });
    const stuck = await this.prisma.walletPassRefreshJob.count({
      where: { ...studioJobs, status: WalletPassRefreshStatus.RUNNING, leaseExpiresAt: { lt: new Date(now.getTime() - WALLET_REFRESH_LEASE_MS) } },
    });
    if (stuck > 0) {
      findings.push({
        code: 'STUCK_JOBS',
        severity: 'HIGH',
        studioId,
        walletCredentialId: null,
        message: 'Refresh jobs are still RUNNING well past their lease; no worker is recovering them.',
        metrics: { stuck },
      });
    }

    if (flags.worker && artifacts.length > 0) {
      const lastCompleted = await this.prisma.walletPassRefreshJob.findFirst({
        where: { ...studioJobs, completedAt: { not: null } },
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true },
      });
      const idleMs = lastCompleted?.completedAt ? now.getTime() - lastCompleted.completedAt.getTime() : null;
      if (idleMs === null || idleMs > WALLET_HEALTH_WORKER_IDLE_MS) {
        findings.push({
          code: 'WORKER_IDLE',
          severity: 'HIGH',
          studioId,
          walletCredentialId: null,
          message: 'The refresh worker is enabled but has completed no job recently (the hourly reconciliation alone should produce some).',
          metrics: { idleMinutes: idleMs === null ? null : Math.round(idleMs / 60_000) },
        });
      }
    }

    // ---- certificate ----------------------------------------------------------------------
    if (flags.dynamic && this.appleProvider.isConfigured()) {
      try {
        const info = this.appleProvider.signingCertificateInfo();
        const { daysLeft, level } = certificateExpiryLevel(info.notAfter, now);
        if (level !== 'OK') {
          findings.push({
            code: 'CERTIFICATE_EXPIRY',
            severity: level === 'EXPIRED' ? 'CRITICAL' : level === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
            studioId: null,
            walletCredentialId: null,
            message: 'The pass-signing certificate (also the APNs identity) is expiring or expired; signing and update notifications stop when it does.',
            metrics: { level, daysLeft, notAfter: info.notAfter.toISOString() },
          });
        }
      } catch {
        findings.push({
          code: 'CERTIFICATE_EXPIRY',
          severity: 'CRITICAL',
          studioId: null,
          walletCredentialId: null,
          message: 'The pass-signing certificate could not be read.',
          metrics: { level: 'UNREADABLE' },
        });
      }
    }

    findings.sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] || x.code.localeCompare(y.code));
    const counts: Record<WalletHealthSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const f of findings) counts[f.severity] += 1;
    return {
      at: now.toISOString(),
      studioId,
      flags,
      totals: {
        dynamicPasses: artifacts.length,
        withActiveRegistration,
        undelivered,
        deadLetters24h: [...deadByStudio.values()].reduce((n, e) => n + e.count, 0),
        queuePendingDue: pendingDue,
        queueRunning: running,
      },
      counts,
      maxSeverity: findings[0]?.severity ?? null,
      findings,
    };
  }

  /** One summary line plus one line per finding; level follows severity. Ids only, no personal data. */
  logReport(report: WalletHealthReport): void {
    const levelOf = (s: WalletHealthSeverity | null) => (s === 'CRITICAL' || s === 'HIGH' ? 'error' : s === 'MEDIUM' ? 'warn' : 'log');
    this.logger[levelOf(report.maxSeverity)](
      JSON.stringify({ event: 'wallet.health.summary', maxSeverity: report.maxSeverity, counts: report.counts, totals: report.totals, flags: report.flags }),
    );
    for (const f of report.findings) {
      this.logger[levelOf(f.severity)](
        JSON.stringify({ event: 'wallet.health.finding', code: f.code, severity: f.severity, studioId: f.studioId, walletCredentialId: f.walletCredentialId, metrics: f.metrics }),
      );
    }
  }
}

/** True when the report contains anything an operator must act on now (cron exit code 3). */
export function walletHealthNeedsAttention(report: Pick<WalletHealthReport, 'maxSeverity'>): boolean {
  return report.maxSeverity === 'CRITICAL' || report.maxSeverity === 'HIGH';
}
