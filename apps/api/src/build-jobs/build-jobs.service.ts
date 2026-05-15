import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BuildWorkerReadinessService, type BuildWorkerReadinessDto } from './build-worker-readiness.service';
import { EasBuildExecutorService } from './eas-build-executor.service';
import type { CreateBuildJobDto } from './dto/create-build-job.dto';

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
   * Allowed even when BUILD_WORKER_ENABLED is false — jobs remain QUEUED until the worker is enabled.
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
        easBuildUrl: null,
        artifactUrl: null,
        startedAt: null,
        finishedAt: null,
      },
      select: buildJobSelect,
    });
  }

  /**
   * Atomically claims the oldest QUEUED job (PostgreSQL SKIP LOCKED). Returns null if none.
   */
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
          eas_build_url = NULL,
          artifact_url = NULL,
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
          },
        });
        this.logger.warn(
          JSON.stringify({
            event: 'build_job_aborted',
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

  async finalizeBuildSuccess(
    job: BuildJobResponse,
    urls: { easBuildUrl: string | null; artifactUrl: string | null },
  ): Promise<void> {
    await this.prisma.buildJob.update({
      where: { id: job.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        easBuildUrl: urls.easBuildUrl ?? null,
        artifactUrl: urls.artifactUrl ?? null,
        errorMessage: null,
      },
    });
    this.logger.log(
      JSON.stringify({
        event: 'build_job_status',
        jobId: job.id,
        studioId: job.studioId,
        platform: job.platform,
        profile: job.profile,
        from: 'RUNNING',
        to: 'SUCCEEDED',
      }),
    );
  }

  async finalizeBuildFailure(job: BuildJobResponse, error: unknown): Promise<void> {
    const errorMessage = this.sanitizeBuildError(error);
    await this.prisma.buildJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        errorMessage,
      },
    });
    this.logger.warn(
      JSON.stringify({
        event: 'build_job_status',
        jobId: job.id,
        studioId: job.studioId,
        platform: job.platform,
        profile: job.profile,
        from: 'RUNNING',
        to: 'FAILED',
      }),
    );
  }

  private sanitizeBuildError(e: unknown): string {
    let msg = e instanceof Error ? e.message : String(e);
    msg = msg.replace(/sk_(live|test)_[a-z0-9]+/gi, '[REDACTED]');
    msg = msg.replace(/Bearer\s+[a-z0-9._-]+/gi, 'Bearer [REDACTED]');
    const max = 4000;
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
