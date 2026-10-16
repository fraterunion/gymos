import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppleWalletProvider } from '../apple/apple-wallet-provider.service';
import { WalletDynamicPassService } from '../dynamic/wallet-dynamic-pass.service';
import { apnsEnabled, refreshWorkerEnabled } from '../dynamic/wallet-dynamic-pass.config';
import {
  certificateExpiryLevel,
  WALLET_REFRESH_BATCH_SIZE,
  WALLET_REFRESH_CERTIFICATE_CHECK_MS,
  WALLET_REFRESH_CHANGE_POLL_MS,
  WALLET_REFRESH_HEALTH_MS,
  WALLET_REFRESH_HEARTBEAT_MS,
  WALLET_REFRESH_RECONCILE_MS,
  WALLET_REFRESH_RETENTION_MS,
  WALLET_REFRESH_TICK_MS,
  WALLET_REFRESH_TRANSITION_SWEEP_MS,
  WALLET_REFRESH_UNDELIVERED_SWEEP_MS,
  walletRefreshInitialReconcileDelayMs,
} from './wallet-refresh.constants';
import { WalletHealthService } from './wallet-health.service';
import { WalletRefreshPermanentError, WalletRefreshProcessorService } from './wallet-refresh-processor.service';
import { sanitizeRefreshError, WalletRefreshQueueService } from './wallet-refresh-queue.service';
import { WalletRefreshTriggersService } from './wallet-refresh-triggers.service';

type Phase = 'changes' | 'transitions' | 'undelivered' | 'reconcile' | 'retention' | 'certificate' | 'health';

export type WalletRefreshJobReport = { jobId: string; studioId: string; result: 'SUCCEEDED' | 'RETRY' | 'FAILED' | 'SUPERSEDED' | 'LOST'; outcome: string };

export type WalletRefreshTickReport = {
  workerId: string;
  at: string;
  recovered: { requeued: number; superseded: number; failed: number };
  phases: Partial<Record<Phase, unknown>>;
  jobs: WalletRefreshJobReport[];
};

/**
 * Smart Wallet 2.0 Stage 3 refresh worker. OFF unless WALLET_REFRESH_WORKER_ENABLED=true (which
 * itself requires WALLET_DYNAMIC_PASSES_ENABLED). Started from the API bootstrap only — never by
 * a CLI that happens to load the module.
 *
 * Each tick (default every 5 s, never overlapping within an instance):
 *   0. record the liveness heartbeat (at most every 30 s; the loop only — CLIs never do);
 *   1. recover expired leases (crash recovery);
 *   2. the phases that are due — change detection (15 s), time-transition sweep (1 min),
 *      pending-delivery sweep (1 min, only while APNs is enabled), reconciliation (1 h; the first
 *      one 5–15 min after start, never at boot), retention (24 h), certificate expiry check (1 h),
 *      health evaluation (15 min) — the scheduling ones guarded by a transaction-scoped advisory
 *      lock so only one instance runs them;
 *   3. claim and process up to 10 due jobs (SKIP LOCKED; safe across instances).
 *
 * No database transaction spans signing or APNs: refresh() signs before its single guarded
 * UPDATE, and pushes happen after it.
 */
@Injectable()
export class WalletRefreshWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(WalletRefreshWorkerService.name);
  readonly workerId = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private heartbeatWrittenAt: number | null = null;
  // Every phase is due at the first tick except reconciliation: re-rendering every pass on each
  // deploy or restart is avoidable load, and nothing depends on it (detection resumes from its
  // durable cursor; transitions and pending deliveries have their own sweeps).
  private readonly lastRunAt: Record<Phase, number> = {
    changes: 0,
    transitions: 0,
    undelivered: 0,
    reconcile: Date.now() - WALLET_REFRESH_RECONCILE_MS + walletRefreshInitialReconcileDelayMs(),
    retention: 0,
    certificate: 0,
    health: 0,
  };

  constructor(
    private readonly config: ConfigService,
    private readonly queue: WalletRefreshQueueService,
    private readonly triggers: WalletRefreshTriggersService,
    private readonly processor: WalletRefreshProcessorService,
    private readonly dynamic: WalletDynamicPassService,
    private readonly appleProvider: AppleWalletProvider,
    private readonly health: WalletHealthService,
  ) {}

  isEnabled(): boolean {
    return refreshWorkerEnabled(this.config) && this.dynamic.isEnabled();
  }

  /** Called once by the API bootstrap. A no-op unless the worker is enabled. */
  start(): boolean {
    if (!this.isEnabled()) {
      this.logger.log(JSON.stringify({ event: 'wallet.refresh.worker_disabled' }));
      return false;
    }
    if (this.timer) return true;
    this.timer = setInterval(() => void this.tick(), WALLET_REFRESH_TICK_MS);
    this.logger.log(JSON.stringify({ event: 'wallet.refresh.worker_started', workerId: this.workerId, tickMs: WALLET_REFRESH_TICK_MS }));
    return true;
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One iteration of the real loop: the interval calls it, tests drive it with a fake clock.
   * Records the liveness heartbeat, then runs a normal cycle; never overlaps itself. Operator
   * CLIs call runOnce() instead, so they can never make a stopped worker look alive.
   */
  async tick(now: Date = new Date()): Promise<WalletRefreshTickReport | null> {
    if (this.ticking) return null;
    this.ticking = true;
    try {
      await this.heartbeat(now);
      return await this.runOnce(now);
    } catch (e) {
      this.logger.error(JSON.stringify({ event: 'wallet.refresh.tick_failed', error: sanitizeRefreshError(e) }));
      return null;
    } finally {
      this.ticking = false;
    }
  }

  private async heartbeat(now: Date): Promise<void> {
    const starting = this.heartbeatWrittenAt === null;
    if (!starting && now.getTime() - this.heartbeatWrittenAt! < WALLET_REFRESH_HEARTBEAT_MS) return;
    try {
      await this.health.recordWorkerHeartbeat(now, { starting });
      this.heartbeatWrittenAt = now.getTime();
    } catch (e) {
      // Liveness bookkeeping must never stop the refresh work itself; a missing heartbeat
      // surfaces as WORKER_STOPPED, which is the truth if the database cannot be written.
      this.logger.error(JSON.stringify({ event: 'wallet.refresh.heartbeat_failed', error: sanitizeRefreshError(e) }));
    }
  }

  /**
   * One full cycle at an explicit clock. `force` runs every trigger phase regardless of cadence
   * (operator CLI, tests); `processJobs: false` stops after enqueueing.
   */
  async runOnce(now: Date, opts: { force?: boolean; processJobs?: boolean; limit?: number } = {}): Promise<WalletRefreshTickReport> {
    const report: WalletRefreshTickReport = {
      workerId: this.workerId,
      at: now.toISOString(),
      recovered: await this.queue.recoverExpiredLeases(now),
      phases: {},
      jobs: [],
    };
    const due = (phase: Phase, everyMs: number) => opts.force === true || now.getTime() - this.lastRunAt[phase] >= everyMs;
    const run = async (phase: Phase, everyMs: number, fn: () => Promise<unknown>) => {
      if (!due(phase, everyMs)) return;
      try {
        report.phases[phase] = await fn();
        this.lastRunAt[phase] = now.getTime();
      } catch (e) {
        report.phases[phase] = { error: sanitizeRefreshError(e) };
        this.logger.error(JSON.stringify({ event: 'wallet.refresh.phase_failed', phase, error: sanitizeRefreshError(e) }));
      }
    };
    await run('changes', WALLET_REFRESH_CHANGE_POLL_MS, () => this.triggers.detectChanges(now));
    await run('transitions', WALLET_REFRESH_TRANSITION_SWEEP_MS, () => this.triggers.sweepTransitions(now));
    if (apnsEnabled(this.config)) {
      await run('undelivered', WALLET_REFRESH_UNDELIVERED_SWEEP_MS, () => this.triggers.sweepUndelivered(now));
    }
    await run('reconcile', WALLET_REFRESH_RECONCILE_MS, () => this.triggers.reconcileAll(now));
    await run('retention', WALLET_REFRESH_RETENTION_MS, () => this.triggers.applyRetention(now));
    await run('certificate', WALLET_REFRESH_CERTIFICATE_CHECK_MS, async () => this.checkCertificate(now));
    await run('health', WALLET_REFRESH_HEALTH_MS, async () => {
      const report = await this.health.evaluate(now);
      this.health.logReport(report);
      return { maxSeverity: report.maxSeverity, counts: report.counts };
    });
    if (opts.processJobs !== false) {
      report.jobs = await this.processDue(now, opts.limit ?? WALLET_REFRESH_BATCH_SIZE);
    }
    return report;
  }

  async processDue(now: Date, limit: number = WALLET_REFRESH_BATCH_SIZE): Promise<WalletRefreshJobReport[]> {
    if (!this.dynamic.isEnabled()) return []; // never claim work that cannot be done
    const jobs = await this.queue.claim(this.workerId, now, limit);
    const results: WalletRefreshJobReport[] = [];
    for (const job of jobs) {
      try {
        const outcome = await this.processor.processMember(job, now);
        const ok = await this.queue.complete(job, this.workerId, outcome, now);
        results.push({ jobId: job.id, studioId: job.studioId, result: ok ? 'SUCCEEDED' : 'LOST', outcome });
      } catch (e) {
        const error = sanitizeRefreshError(e);
        if (e instanceof WalletRefreshPermanentError) {
          const failed = await this.queue.fail(job, this.workerId, e.code, now);
          results.push({ jobId: job.id, studioId: job.studioId, result: failed ? 'FAILED' : 'LOST', outcome: e.code });
        } else {
          const result = await this.queue.retryOrFail(job, this.workerId, e, now);
          results.push({ jobId: job.id, studioId: job.studioId, result, outcome: error });
        }
        this.logger.warn(JSON.stringify({ event: 'wallet.refresh.job_failed', jobId: job.id, studioId: job.studioId, attempts: job.attempts, error }));
      }
    }
    return results;
  }

  /** Logs a warning (< 30 days), an error (< 7 days) or an error (expired) for the signing certificate. */
  checkCertificate(now: Date): { level: string; daysLeft: number | null; notAfter: string | null } {
    if (!this.appleProvider.isConfigured()) return { level: 'NOT_CONFIGURED', daysLeft: null, notAfter: null };
    try {
      const info = this.appleProvider.signingCertificateInfo();
      const { daysLeft, level } = certificateExpiryLevel(info.notAfter, now);
      const payload = { event: 'wallet.certificate.expiry', level, daysLeft, notAfter: info.notAfter.toISOString(), passTypeIdentifier: info.passTypeIdentifier };
      if (level === 'OK') this.logger.log(JSON.stringify(payload));
      else if (level === 'WARN') this.logger.warn(JSON.stringify(payload));
      else this.logger.error(JSON.stringify(payload));
      return { level, daysLeft, notAfter: info.notAfter.toISOString() };
    } catch (e) {
      this.logger.error(JSON.stringify({ event: 'wallet.certificate.unreadable', error: sanitizeRefreshError(e) }));
      return { level: 'UNREADABLE', daysLeft: null, notAfter: null };
    }
  }
}
