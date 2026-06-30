import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StripeModule } from '../stripe/stripe.module';
import { WaiverModule } from '../waiver/waiver.module';
import { DayPassesController } from './day-passes.controller';
import { DayPassesService } from './day-passes.service';

@Module({
  imports: [PrismaModule, AuthModule, StripeModule, ConfigModule, WaiverModule],
  controllers: [DayPassesController],
  providers: [DayPassesService],
  exports: [DayPassesService],
})
export class DayPassesModule {}
