import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformOperatorGuard } from '../auth/guards/platform-operator.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import type { JwtUser } from '../auth/interfaces/jwt-user.type';
import { BuildJobsService } from './build-jobs.service';
import { CreateBuildJobDto } from './dto/create-build-job.dto';

@Controller('studios/:studioId/build-jobs')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard, PlatformOperatorGuard)
@Roles(Role.OWNER, Role.ADMIN)
export class BuildJobsController {
  constructor(private readonly buildJobsService: BuildJobsService) {}

  @Get('worker-info')
  async workerInfo(@Param('studioId') studioId: string) {
    return this.buildJobsService.getWorkerReadiness(studioId);
  }

  @Get()
  list(@Param('studioId') studioId: string) {
    return this.buildJobsService.listForStudio(studioId);
  }

  @Get(':jobId')
  getOne(@Param('studioId') studioId: string, @Param('jobId') jobId: string) {
    return this.buildJobsService.getById(studioId, jobId);
  }

  @Post()
  create(
    @Param('studioId') studioId: string,
    @Body() dto: CreateBuildJobDto,
    @CurrentUser() user: JwtUser,
  ) {
    return this.buildJobsService.create(studioId, user.sub, dto);
  }

  @Post(':jobId/run')
  run(@Param('studioId') studioId: string, @Param('jobId') jobId: string) {
    return this.buildJobsService.run(studioId, jobId);
  }
}
