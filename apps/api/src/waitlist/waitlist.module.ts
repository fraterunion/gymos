import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BookingAccessService } from '../bookings/booking-access.service';
import { MembershipUsageModule } from '../membership-usage/membership-usage.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ClassWaitlistController } from './class-waitlist.controller';
import { StudioWaitlistController } from './studio-waitlist.controller';
import { WaiverModule } from '../waiver/waiver.module';
import { WaitlistService } from './waitlist.service';

@Module({
  imports: [PrismaModule, AuthModule, MembershipUsageModule, WaiverModule],
  controllers: [ClassWaitlistController, StudioWaitlistController],
  providers: [WaitlistService, BookingAccessService],
  exports: [WaitlistService],
})
export class WaitlistModule {}
