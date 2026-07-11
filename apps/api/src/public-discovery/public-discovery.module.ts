import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StudioScheduleModule } from '../schedule/schedule.module';
import { PublicDiscoveryController } from './public-discovery.controller';
import { PublicDiscoveryService } from './public-discovery.service';
import { PublicThrottlerGuard } from './public-throttler.guard';

@Module({
  imports: [PrismaModule, StudioScheduleModule],
  controllers: [PublicDiscoveryController],
  providers: [PublicDiscoveryService, PublicThrottlerGuard],
})
export class PublicDiscoveryModule {}
