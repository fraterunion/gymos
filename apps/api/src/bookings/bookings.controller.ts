import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { BookingsService } from './bookings.service';

@Controller('studios/:studioId/bookings')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Get('me')
  listMine(@Param('studioId') studioId: string, @CurrentUser('sub') userId: string) {
    return this.bookingsService.listMyUpcomingBookings(studioId, userId);
  }

  @Post(':bookingId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @Param('studioId') studioId: string,
    @Param('bookingId') bookingId: string,
    @CurrentUser('sub') userId: string,
  ) {
    await this.bookingsService.cancelBooking(studioId, bookingId, userId);
  }
}
