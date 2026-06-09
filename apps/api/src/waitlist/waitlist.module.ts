import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BookingAccessService } from '../bookings/booking-access.service';
import { ClassWaitlistController } from './class-waitlist.controller';
import { StudioWaitlistController } from './studio-waitlist.controller';
import { WaitlistService } from './waitlist.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ClassWaitlistController, StudioWaitlistController],
  providers: [WaitlistService, BookingAccessService],
  exports: [WaitlistService],
})
export class WaitlistModule {}
