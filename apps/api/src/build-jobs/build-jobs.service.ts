import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

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
