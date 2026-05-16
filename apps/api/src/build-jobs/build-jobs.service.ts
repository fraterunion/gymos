import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BuildJobErrorCategory, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { classifyBuildError } from './build-job-error-category';
import { BuildWorkerReadinessService, type BuildWorkerReadinessDto } from './build-worker-readiness.service';
import { EasBuildExecutorService, type EasBuildExecuteResult } from './eas-build-executor.service';
import type { EasRemoteBuildStatus } from './eas-status-poller.service';
import type { CreateBuildJobDto } from './dto/create-build-job.dto';

const STUCK_RUNNING_MS = 30 * 60 * 1000;

const studioMobileSelect = {
  appDisplayName: true,
  appName: true,
  appScheme: true,
  expoSlug: true,
  iosBundleId: true,
  androidPackageName: true,
} satisfies Prisma.StudioSelect;

type StudioMobileRow = Prisma.StudioGetPayload<{ select: typeof studioMobileSelect }>;

const buildJobSelect = {
  id: true,
  studioId: true,
  requestedByUserId: true,
  platform: true,
  profile: true,
  status: true,
  appDisplayName: true,
  appScheme: true,
  expoSlug: true,
  iosBundleIdentifier: true,
  androidPackage: true,
  easBuildUrl: true,
  artifactUrl: true,
  errorMessage: true,
  errorCategory: true,
  submittedAt: true,
  expoBuildId: true,
  expoBuildStatus: true,
  lastCheckedAt: true,
  requestedAt: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BuildJobSelect;

export type BuildJobResponse = Prisma.BuildJobGetPayload<{ select: typeof buildJobSelect }>;

@Injectable()
export class BuildJobsService {
  private readonly logger = new Logger(BuildJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly easExecutor: EasBuildExecutorService,
    private readonly workerReadiness: BuildWorkerReadinessService,
  ) {}

  async listForStudio(studioId: string): Promise<BuildJobResponse[]> {
    await this.assertStudioExists(studioId);
    return this.prisma.buildJob.findMany({
      where: { studioId },
      orderBy: { requestedAt: 'desc' },
      take: 50,
      select: buildJobSelect,
    });
  }

  async getById(studioId: string, jobId: string): Promise<BuildJobResponse> {
    await this.assertStudioExists(studioId);
    const job = await this.prisma.buildJob.findFirst({
      where: { id: jobId, studioId },
      select: buildJobSelect,
    });
    if (!job) {
      throw new NotFoundException('Build job not found');
    }
    return job;
  }

  async create(
    studioId: string,
    requestedByUserId: string,
    dto: CreateBuildJobDto,
  ): Promise<BuildJobResponse> {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: studioMobileSelect,
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }

    const snapshot = this.snapshotFromStudio(studio);
    this.assertCompleteMobileSnapshot(snapshot);

    return this.prisma.buildJob.create({
      data: {
        studioId,
        requestedByUserId,
        platform: dto.platform,
        profile: dto.profile,
        status: 'QUEUED',
        appDisplayName: snapshot.appDisplayName,
        appScheme: snapshot.appScheme,
        expoSlug: snapshot.expoSlug,
        iosBundleIdentifier: snapshot.iosBundleIdentifier,
        androidPackage: snapshot.androidPackage,
      },
      select: buildJobSelect,
    });
  }

  async getWorkerReadiness(studioId: string): Promise<BuildWorkerReadinessDto> {
    await this.assertStudioExists(studioId);
    return this.workerReadiness.gatherWorkerReadiness();
  }

  /**
   * Enqueues (or re-queues) a build for the async worker. Does not invoke EAS on the HTTP thread.
   */
  async run(studioId: string, jobId: string): Promise<BuildJobResponse> {
    const job = await this.prisma.buildJob.findFirst({
      where: { id: jobId, studioId },
      select: buildJobSelect,
    });
    if (!job) {
      throw new NotFoundException('Build job not found');
    }
    if (job.status === 'RUNNING') {
      throw new ConflictException('Build job is already running.');
    }
    if (job.status !== 'QUEUED' && job.status !== 'FAILED') {
      throw new BadRequestException('Only QUEUED or FAILED build jobs can be enqueued.');
    }

    return this.prisma.buildJob.update({
      where: { id: jobId },
      data: {
        status: 'QUEUED',
        errorMessage: null,
        errorCategory: null,
        easBuildUrl: null,
        artifactUrl: null,
        submittedAt: null,
        expoBuildId: null,
        expoBuildStatus: null,
        lastCheckedAt: null,
        startedAt: null,
        finishedAt: null,
      },
      select: buildJobSelect,
    });
  }

  /**
   * Marks RUNNING jobs stuck without an EAS URL as FAILED (TIMEOUT).
   * Jobs that already have easBuildUrl are left alone (submitted to Expo).
   */
  async recoverStuckRunningJobs(): Promise<number> {
    const threshold = new Date(Date.now() - STUCK_RUNNING_MS);
    const stuck = await this.prisma.buildJob.findMany({
      where: {
        status: 'RUNNING',
        startedAt: { lt: threshold },
        easBuildUrl: null,
      },
      select: buildJobSelect,
    });

    for (const job of stuck) {
      await this.finalizeBuildFailure(
        job,
        new Error(
          'Build timed out: no EAS build URL was captured within 30 minutes while the job was RUNNING.',
        ),
        BuildJobErrorCategory.TIMEOUT,
      );
    }

    if (stuck.length > 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'build_jobs_stuck_recovered',
          count: stuck.length,
          jobIds: stuck.map((j) => j.id),
        }),
      );
    }

    return stuck.length;
  }

  async claimNextQueuedJob(): Promise<{ job: BuildJobResponse; studioSlug: string } | null> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const rows = await tx.$queryRaw<{ id: string }[]>`
        WITH picked AS (
          SELECT id FROM build_jobs
          WHERE status = 'QUEUED'::"BuildJobStatus"
          ORDER BY requested_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE build_jobs AS b
        SET
          status = 'RUNNING'::"BuildJobStatus",
          started_at = ${now},
          error_message = NULL,
          error_category = NULL,
          eas_build_url = NULL,
          artifact_url = NULL,
          submitted_at = NULL,
          expo_build_id = NULL,
          expo_build_status = NULL,
          last_checked_at = ${now},
          finished_at = NULL
        FROM picked
        WHERE b.id = picked.id
        RETURNING b.id
      `;
      const id = rows[0]?.id;
      if (!id) {
        return null;
      }

      const job = await tx.buildJob.findUnique({
        where: { id },
        select: buildJobSelect,
      });
      if (!job) {
        return null;
      }

      const studio = await tx.studio.findFirst({
        where: { id: job.studioId, deletedAt: null },
        select: { slug: true },
      });
      if (!studio) {
        await tx.buildJob.update({
          where: { id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            errorMessage: 'Studio not found; cannot run EAS build.',
            errorCategory: BuildJobErrorCategory.CONFIG_ERROR,
            lastCheckedAt: new Date(),
          },
        });
        this.logger.warn(
          JSON.stringify({
            event: 'build_job_failed',
            jobId: id,
            studioId: job.studioId,
            reason: 'studio_missing',
          }),
        );
        return null;
      }

      return { job, studioSlug: studio.slug };
    });
  }

  async finalizeBuildSuccess(job: BuildJobResponse, result: EasBuildExecuteResult): Promise<void> {
    const now = new Date();
    await this.prisma.buildJob.update({
      where: { id: job.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: now,
        submittedAt: result.submittedAt ?? now,
        easBuildUrl: result.easBuildUrl ?? null,
        artifactUrl: result.artifactUrl ?? null,
        expoBuildId: result.expoBuildId ?? null,
        expoBuildStatus: result.expoBuildStatus ?? (result.easBuildUrl ? 'SUBMITTED' : null),
        lastCheckedAt: now,
        errorMessage: null,
        errorCategory: null,
      },
    });
    this.logger.log(
      JSON.stringify({
        event: 'build_job_succeeded',
        jobId: job.id,
        studioId: job.studioId,
        platform: job.platform,
        profile: job.profile,
        easBuildUrl: result.easBuildUrl ? true : false,
        expoBuildId: result.expoBuildId ?? null,
      }),
    );
  }

  async finalizeBuildFailure(
    job: BuildJobResponse,
    error: unknown,
    categoryOverride?: BuildJobErrorCategory,
  ): Promise<void> {
    const errorMessage = this.sanitizeBuildError(error);
    const errorCategory = categoryOverride ?? classifyBuildError(errorMessage);
    const now = new Date();
    await this.prisma.buildJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        finishedAt: now,
        errorMessage,
        errorCategory,
        lastCheckedAt: now,
      },
    });
    this.logger.warn(
      JSON.stringify({
        event: 'build_job_failed',
        jobId: job.id,
        studioId: job.studioId,
        platform: job.platform,
        profile: job.profile,
        errorCategory,
        // Include first 800 chars so Railway logs expose the actual failure cause.
        errorMessage: errorMessage.slice(0, 800),
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // EAS remote status polling (called by BuildJobsStatusPollerService)
  // ---------------------------------------------------------------------------

  /**
   * Returns SUCCEEDED jobs that have an expoBuildId and are not yet terminal on Expo's side.
   * Ordered oldest-checked-first so stale jobs get priority on every tick.
   */
  async findByExpoBuildId(expoBuildId: string): Promise<BuildJobResponse | null> {
    return this.prisma.buildJob.findFirst({
      where: { expoBuildId },
      select: buildJobSelect,
    });
  }

  async listPollableJobs(limit: number): Promise<BuildJobResponse[]> {
    return this.prisma.buildJob.findMany({
      where: {
        status: 'SUCCEEDED',
        expoBuildId: { not: null },
        expoBuildStatus: { notIn: ['FINISHED', 'ERRORED', 'CANCELED'] },
      },
      orderBy: { lastCheckedAt: 'asc' },
      take: limit,
      select: buildJobSelect,
    });
  }

  /** Updates only lastCheckedAt — used when the Expo API is unreachable. */
  async touchLastChecked(jobId: string): Promise<void> {
    await this.prisma.buildJob.update({
      where: { id: jobId },
      data: { lastCheckedAt: new Date() },
    });
  }

  /**
   * Applies an Expo API poll result to the DB row.
   * - FINISHED → keeps SUCCEEDED, sets artifactUrl + finishedAt
   * - ERRORED   → FAILED + BUILD_FAILED category + errorMessage
   * - CANCELED  → CANCELED + finishedAt
   * - Other     → updates expoBuildStatus + lastCheckedAt only
   */
  async syncEasBuildStatus(jobId: string, remote: EasRemoteBuildStatus): Promise<void> {
    const now = new Date();
    const { expoStatus, artifactUrl, completedAt, errorMessage } = remote;
    const isTerminal = ['FINISHED', 'ERRORED', 'CANCELED'].includes(expoStatus);

    type StatusLiteral = 'SUCCEEDED' | 'FAILED' | 'CANCELED';
    let newStatus: StatusLiteral = 'SUCCEEDED';
    let errorCategory: BuildJobErrorCategory | null = null;
    let resolvedErrorMessage: string | null = null;

    if (expoStatus === 'ERRORED') {
      newStatus = 'FAILED';
      errorCategory = BuildJobErrorCategory.BUILD_FAILED;
      resolvedErrorMessage = errorMessage ?? 'Remote EAS build reported an error.';
    } else if (expoStatus === 'CANCELED') {
      newStatus = 'CANCELED';
    }

    await this.prisma.buildJob.update({
      where: { id: jobId },
      data: {
        expoBuildStatus: expoStatus,
        lastCheckedAt: now,
        ...(newStatus !== 'SUCCEEDED' && { status: newStatus }),
        ...(isTerminal && { finishedAt: completedAt ?? now }),
        ...(artifactUrl != null && { artifactUrl }),
        ...(errorCategory != null && { errorCategory }),
        ...(resolvedErrorMessage != null && { errorMessage: resolvedErrorMessage }),
      },
    });

    if (isTerminal) {
      this.logger.log(
        JSON.stringify({
          event: 'build_job_remote_finalized',
          jobId,
          expoStatus,
          localStatus: newStatus,
          hasArtifact: artifactUrl != null,
        }),
      );
    }
  }

  private sanitizeBuildError(e: unknown): string {
    let msg = e instanceof Error ? e.message : String(e);
    msg = msg.replace(/sk_(live|test)_[a-z0-9]+/gi, '[REDACTED]');
    msg = msg.replace(/Bearer\s+[a-z0-9._-]+/gi, 'Bearer [REDACTED]');
    const max = 16_000;
    if (msg.length > max) return `${msg.slice(0, max)}…`;
    return msg;
  }

  private snapshotFromStudio(s: StudioMobileRow) {
    const appDisplayName = (s.appDisplayName?.trim() || s.appName?.trim() || '').trim();
    return {
      appDisplayName,
      appScheme: (s.appScheme ?? '').trim(),
      expoSlug: (s.expoSlug ?? '').trim(),
      iosBundleIdentifier: (s.iosBundleId ?? '').trim(),
      androidPackage: (s.androidPackageName ?? '').trim(),
    };
  }

  private assertCompleteMobileSnapshot(s: {
    appDisplayName: string;
    appScheme: string;
    expoSlug: string;
    iosBundleIdentifier: string;
    androidPackage: string;
  }) {
    const missing: string[] = [];
    if (!s.appDisplayName) missing.push('appDisplayName');
    if (!s.appScheme) missing.push('appScheme');
    if (!s.expoSlug) missing.push('expoSlug');
    if (!s.iosBundleIdentifier) missing.push('iosBundleIdentifier');
    if (!s.androidPackage) missing.push('androidPackage');
    if (missing.length > 0) {
      throw new BadRequestException(
        `Complete mobile configuration on the studio before requesting a build (missing: ${missing.join(', ')}).`,
      );
    }
  }

  private async assertStudioExists(studioId: string): Promise<void> {
    const n = await this.prisma.studio.count({ where: { id: studioId, deletedAt: null } });
    if (n === 0) throw new NotFoundException('Studio not found');
  }
}
