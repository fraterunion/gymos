import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ScheduleGeneratorController } from './schedule-generator.controller';
import { ScheduleGeneratorService } from './schedule-generator.service';
import { ScheduleAutomationService } from './schedule-automation.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ScheduleGeneratorController],
  providers: [ScheduleGeneratorService, ScheduleAutomationService],
  exports: [ScheduleGeneratorService],
})
export class ScheduleGeneratorModule {}
