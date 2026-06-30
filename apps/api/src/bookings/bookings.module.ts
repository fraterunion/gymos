import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WaiverModule } from '../waiver/waiver.module';
import { WaitlistModule } from '../waitlist/waitlist.module';
import { BookingAccessService } from './booking-access.service';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { ClassBookingsController } from './class-bookings.controller';

@Module({
  imports: [PrismaModule, AuthModule, WaitlistModule, WaiverModule],
  controllers: [BookingsController, ClassBookingsController],
  providers: [BookingsService, BookingAccessService],
})
export class BookingsModule {}
