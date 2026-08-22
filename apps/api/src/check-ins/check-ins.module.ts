import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MembershipUsageModule } from '../membership-usage/membership-usage.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WaiverModule } from '../waiver/waiver.module';
import { WalletModule } from '../wallet/wallet.module';
import { BookingCheckInsController } from './booking-check-ins.controller';
import { ClassAttendanceController } from './class-attendance.controller';
import { CheckInsService } from './check-ins.service';
import { StudioCheckInsController } from './studio-check-ins.controller';

@Module({
  imports: [PrismaModule, AuthModule, WaiverModule, MembershipUsageModule, WalletModule],
  controllers: [BookingCheckInsController, StudioCheckInsController, ClassAttendanceController],
  providers: [CheckInsService],
  exports: [CheckInsService],
})
export class CheckInsModule {}
