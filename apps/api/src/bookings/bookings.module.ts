import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WaitlistModule } from '../waitlist/waitlist.module';
import { BookingAccessService } from './booking-access.service';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { ClassBookingsController } from './class-bookings.controller';

@Module({
  imports: [PrismaModule, AuthModule, WaitlistModule],
  controllers: [BookingsController, ClassBookingsController],
  providers: [BookingsService, BookingAccessService],
})
export class BookingsModule {}
