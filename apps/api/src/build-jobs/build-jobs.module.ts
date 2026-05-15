import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BuildJobsController } from './build-jobs.controller';
import { BuildJobsService } from './build-jobs.service';
import { EasBuildExecutorService } from './eas-build-executor.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [BuildJobsController],
  providers: [BuildJobsService, EasBuildExecutorService],
})
export class BuildJobsModule {}
