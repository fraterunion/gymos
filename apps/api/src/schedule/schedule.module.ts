import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SalesModule } from '../sales/sales.module';
import { ScheduleOperationsController } from './schedule-operations.controller';
import { ScheduleOperationsService } from './schedule-operations.service';
import { ScheduleController } from './schedule.controller';
import { ScheduleConflictsService } from './schedule-conflicts.service';
import { ScheduleSeriesController } from './schedule-series.controller';
import { ScheduleSeriesService } from './schedule-series.service';
import { ScheduleService } from './schedule.service';
import { ScheduleSessionService } from './schedule-session.service';

@Module({
  imports: [PrismaModule, AuthModule, SalesModule],
  controllers: [ScheduleController, ScheduleSeriesController, ScheduleOperationsController],
  providers: [
    ScheduleService,
    ScheduleSessionService,
    ScheduleSeriesService,
    ScheduleConflictsService,
    ScheduleOperationsService,
  ],
  exports: [
    ScheduleService,
    ScheduleSessionService,
    ScheduleSeriesService,
    ScheduleConflictsService,
    ScheduleOperationsService,
  ],
})
export class StudioScheduleModule {}
