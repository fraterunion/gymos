import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ScheduleTemplatesController } from './schedule-templates.controller';
import { ScheduleTemplatesService } from './schedule-templates.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ScheduleTemplatesController],
  providers: [ScheduleTemplatesService],
  exports: [ScheduleTemplatesService],
})
export class ScheduleTemplatesModule {}
