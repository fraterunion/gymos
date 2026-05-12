import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { ClassBookingsController } from './class-bookings.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [BookingsController, ClassBookingsController],
  providers: [BookingsService],
})
export class BookingsModule {}
