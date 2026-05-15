import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly easExecutor: EasBuildExecutorService,
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

  getWorkerInfo(): { workerEnabled: boolean } {
    return { workerEnabled: this.easExecutor.isWorkerEnabled() };
  }

  async run(studioId: string, jobId: string): Promise<BuildJobResponse> {
    if (!this.easExecutor.isWorkerEnabled()) {
      throw new ForbiddenException('Build worker is disabled in this environment.');
    }
    this.easExecutor.assertReadyForExecution();

    const job = await this.prisma.buildJob.findFirst({
      where: { id: jobId, studioId },
      select: buildJobSelect,
    });
    if (!job) {
      throw new NotFoundException('Build job not found');
    }
    if (job.status !== 'QUEUED' && job.status !== 'FAILED') {
      throw new BadRequestException('Only QUEUED or FAILED build jobs can be run.');
    }

    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { slug: true },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }

    const transition = await this.prisma.buildJob.updateMany({
      where: {
        id: jobId,
        studioId,
        status: { in: ['QUEUED', 'FAILED'] },
      },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        errorMessage: null,
        easBuildUrl: null,
        artifactUrl: null,
      },
    });
    if (transition.count === 0) {
      throw new BadRequestException('Build job is no longer in a runnable state.');
    }

    try {
      const { easBuildUrl, artifactUrl } = await this.easExecutor.execute(job, studio.slug);
      return await this.prisma.buildJob.update({
        where: { id: jobId },
        data: {
          status: 'SUCCEEDED',
          finishedAt: new Date(),
          easBuildUrl: easBuildUrl ?? null,
          artifactUrl: artifactUrl ?? null,
        },
        select: buildJobSelect,
      });
    } catch (e) {
      const errorMessage = this.sanitizeBuildError(e);
      return await this.prisma.buildJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorMessage,
        },
        select: buildJobSelect,
      });
    }
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
