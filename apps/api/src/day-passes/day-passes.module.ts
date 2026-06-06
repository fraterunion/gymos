import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DayPassesController } from './day-passes.controller';
import { DayPassesService } from './day-passes.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [DayPassesController],
  providers: [DayPassesService],
  exports: [DayPassesService],
})
export class DayPassesModule {}
