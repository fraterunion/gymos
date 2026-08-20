import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SalesModule } from '../sales/sales.module';
import { ScheduleController } from './schedule.controller';
import { ScheduleConflictsService } from './schedule-conflicts.service';
import { ScheduleSeriesController } from './schedule-series.controller';
import { ScheduleSeriesService } from './schedule-series.service';
import { ScheduleService } from './schedule.service';

@Module({
  imports: [PrismaModule, AuthModule, SalesModule],
  controllers: [ScheduleController, ScheduleSeriesController],
  providers: [ScheduleService, ScheduleSeriesService, ScheduleConflictsService],
  exports: [ScheduleService, ScheduleSeriesService, ScheduleConflictsService],
})
export class StudioScheduleModule {}
