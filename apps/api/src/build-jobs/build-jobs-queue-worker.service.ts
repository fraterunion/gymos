import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BuildJobsService } from './build-jobs.service';
import { EasBuildExecutorService } from './eas-build-executor.service';

/** In-process guard so a single API instance never runs two EAS builds concurrently. */
@Injectable()
export class BuildJobsQueueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BuildJobsQueueWorkerService.name);
  private interval: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;

  constructor(
    private readonly config: ConfigService,
    private readonly buildJobs: BuildJobsService,
    private readonly easExecutor: EasBuildExecutorService,
  ) {}

  onModuleInit(): void {
    const ms = this.resolvePollIntervalMs();
    this.interval = setInterval(() => {
      void this.safePollTick();
    }, ms);
    this.logger.log(
      JSON.stringify({
        event: 'build_queue_worker_started',
        pollIntervalMs: ms,
      }),
    );
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private resolvePollIntervalMs(): number {
    const raw = this.config.get<string>('BUILD_QUEUE_POLL_INTERVAL_MS');
    const n = raw !== undefined && raw !== null && raw !== '' ? Number(raw) : 45_000;
    if (!Number.isFinite(n)) return 45_000;
    return Math.min(120_000, Math.max(30_000, Math.floor(n)));
  }

  private async safePollTick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      await this.pollTick();
    } catch (e) {
      this.logger.warn(
        JSON.stringify({
          event: 'build_queue_worker_tick_error',
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      this.tickInFlight = false;
    }
  }

  private async pollTick(): Promise<void> {
    if (!this.easExecutor.isWorkerEnabled()) {
      return;
    }
    try {
      this.easExecutor.assertReadyForExecution();
    } catch {
      return;
    }

    const claimed = await this.buildJobs.claimNextQueuedJob();
    if (!claimed) {
      return;
    }

    const { job, studioSlug } = claimed;
    this.logger.log(
      JSON.stringify({
        event: 'build_job_status',
        jobId: job.id,
        studioId: job.studioId,
        platform: job.platform,
        profile: job.profile,
        from: 'QUEUED',
        to: 'RUNNING',
      }),
    );

    try {
      const { easBuildUrl, artifactUrl } = await this.easExecutor.execute(job, studioSlug);
      await this.buildJobs.finalizeBuildSuccess(job, { easBuildUrl, artifactUrl });
    } catch (e) {
      await this.buildJobs.finalizeBuildFailure(job, e);
    }
  }
}
