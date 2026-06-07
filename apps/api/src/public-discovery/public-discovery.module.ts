import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ScheduleModule } from '../schedule/schedule.module';
import { PublicDiscoveryController } from './public-discovery.controller';
import { PublicDiscoveryService } from './public-discovery.service';

@Module({
  imports: [PrismaModule, ScheduleModule],
  controllers: [PublicDiscoveryController],
  providers: [PublicDiscoveryService],
})
export class PublicDiscoveryModule {}
