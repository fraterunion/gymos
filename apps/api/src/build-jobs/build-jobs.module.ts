import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BuildJobsController } from './build-jobs.controller';
import { BuildJobsQueueWorkerService } from './build-jobs-queue-worker.service';
import { BuildJobsService } from './build-jobs.service';
import { BuildWorkerReadinessService } from './build-worker-readiness.service';
import { EasBuildExecutorService } from './eas-build-executor.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [BuildJobsController],
  providers: [
    BuildJobsService,
    EasBuildExecutorService,
    BuildWorkerReadinessService,
    BuildJobsQueueWorkerService,
  ],
})
export class BuildJobsModule {}
