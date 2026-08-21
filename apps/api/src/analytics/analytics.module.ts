import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { ExecutiveDashboardService } from './executive-dashboard.service';
import { FinancialActivityService } from './financial-activity.service';

import { MemberAnalyticsService } from './member-analytics.service';
import { RetentionAnalyticsService } from './retention-analytics.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    ExecutiveDashboardService,
    FinancialActivityService,
    MemberAnalyticsService,
    RetentionAnalyticsService,
  ],
})
export class AnalyticsModule {}
