import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BuildJobsService } from './build-jobs.service';
import { EasStatusPollerService } from './eas-status-poller.service';

/**
 * BUILD_STATUS_POLL_INTERVAL_MS — how often to check Expo API for non-terminal build statuses.
 * Default: 90 s. Range: 60 s – 300 s.
 * Keep above 60 s to avoid hammering the Expo API.
 */
export function resolveStatusPollIntervalMs(config: ConfigService): number {
  const raw = config.get<string>('BUILD_STATUS_POLL_INTERVAL_MS');
  const n = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : 90_000;
  if (!Number.isFinite(n)) return 90_000;
  return Math.min(300_000, Math.max(60_000, Math.floor(n)));
}

/**
 * BUILD_STATUS_POLL_LIMIT — max jobs checked per tick.
 * Default: 5. Range: 1 – 20.
 */
function resolveStatusPollLimit(config: ConfigService): number {
  const raw = config.get<string>('BUILD_STATUS_POLL_LIMIT');
  const n = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : 5;
  if (!Number.isFinite(n) || n < 1) return 5;
  return Math.min(20, Math.floor(n));
}

/**
 * Periodically checks the Expo REST API for non-terminal EAS builds and syncs the DB.
 *
 * Runs independently of BuildJobsQueueWorkerService — never blocks submission.
 * Safe to disable by setting BUILD_WORKER_ENABLED=false (it will still sync status for
 * already-submitted builds; if you want to stop ALL worker activity, also remove the token).
 */
@Injectable()
export class BuildJobsStatusPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BuildJobsStatusPollerService.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;

  constructor(
    private readonly config: ConfigService,
    private readonly buildJobs: BuildJobsService,
    private readonly easPoller: EasStatusPollerService,
  ) {}

  onModuleInit(): void {
    const ms = resolveStatusPollIntervalMs(this.config);
    const limit = resolveStatusPollLimit(this.config);
    this.interval = setInterval(() => {
      void this.safePollTick();
    }, ms);
    this.logger.log(
      JSON.stringify({
        event: 'build_status_poller_started',
        pollIntervalMs: ms,
        pollLimit: limit,
      }),
    );
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async safePollTick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      await this.pollTick();
    } catch (e) {
      this.logger.warn(
        JSON.stringify({
          event: 'build_status_poller_tick_error',
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      this.tickInFlight = false;
    }
  }

  private async pollTick(): Promise<void> {
    const token = this.config.get<string>('EAS_ACCESS_TOKEN')?.trim();
    if (!token) return;

    const limit = resolveStatusPollLimit(this.config);
    const jobs = await this.buildJobs.listPollableJobs(limit);
    if (jobs.length === 0) return;

    this.logger.log(
      JSON.stringify({ event: 'build_status_poll_tick', checking: jobs.length }),
    );

    for (const job of jobs) {
      if (!job.expoBuildId) continue;

      const remote = await this.easPoller.fetchBuildStatus(job.expoBuildId);
      if (!remote) {
        // Expo unreachable — touch lastCheckedAt so this job moves to the back of the queue
        await this.buildJobs.touchLastChecked(job.id);
        continue;
      }

      await this.buildJobs.syncEasBuildStatus(job.id, remote);
    }
  }
}
