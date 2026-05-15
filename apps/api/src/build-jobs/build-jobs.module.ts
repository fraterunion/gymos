import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BuildJobsController } from './build-jobs.controller';
import { ExpoBuildWebhookController } from './expo-build-webhook.controller';
import { ExpoBuildWebhookService } from './expo-build-webhook.service';
import { BuildJobsQueueWorkerService } from './build-jobs-queue-worker.service';
import { BuildJobsStatusPollerService } from './build-jobs-status-poller.service';
import { BuildJobsService } from './build-jobs.service';
import { BuildWorkerReadinessService } from './build-worker-readiness.service';
import { EasBuildExecutorService } from './eas-build-executor.service';
import { EasStatusPollerService } from './eas-status-poller.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [BuildJobsController, ExpoBuildWebhookController],
  providers: [
    BuildJobsService,
    ExpoBuildWebhookService,
    EasBuildExecutorService,
    BuildWorkerReadinessService,
    BuildJobsQueueWorkerService,
    EasStatusPollerService,
    BuildJobsStatusPollerService,
  ],
})
export class BuildJobsModule {}
