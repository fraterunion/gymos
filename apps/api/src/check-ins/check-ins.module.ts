import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WaiverModule } from '../waiver/waiver.module';
import { BookingCheckInsController } from './booking-check-ins.controller';
import { ClassAttendanceController } from './class-attendance.controller';
import { CheckInsService } from './check-ins.service';
import { StudioCheckInsController } from './studio-check-ins.controller';

@Module({
  imports: [PrismaModule, AuthModule, WaiverModule],
  controllers: [BookingCheckInsController, StudioCheckInsController, ClassAttendanceController],
  providers: [CheckInsService],
})
export class CheckInsModule {}
