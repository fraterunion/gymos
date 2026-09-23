import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SalesModule } from '../sales/sales.module';
import { StripeModule } from '../stripe/stripe.module';
import { WaiverModule } from '../waiver/waiver.module';
import { DayPassAttemptSweepService } from './day-pass-attempt-sweep.service';
import { DayPassClassAccessController } from './day-pass-class-access.controller';
import { DayPassClassAccessService } from './day-pass-class-access.service';
import { DayPassSettingsController } from './day-pass-settings.controller';
import { DayPassSettingsService } from './day-pass-settings.service';
import { DayPassesController } from './day-passes.controller';
import { DayPassesService } from './day-passes.service';

@Module({
  imports: [PrismaModule, AuthModule, StripeModule, ConfigModule, WaiverModule, SalesModule],
  controllers: [DayPassesController, DayPassClassAccessController, DayPassSettingsController],
  providers: [DayPassesService, DayPassClassAccessService, DayPassSettingsService, DayPassAttemptSweepService],
  exports: [DayPassesService, DayPassClassAccessService, DayPassSettingsService, DayPassAttemptSweepService],
})
export class DayPassesModule {}
