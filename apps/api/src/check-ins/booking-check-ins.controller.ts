import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CheckInsService } from './check-ins.service';

@Controller('studios/:studioId/bookings/:bookingId')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class BookingCheckInsController {
  constructor(private readonly checkInsService: CheckInsService) {}

  @Post('qr')
  @HttpCode(HttpStatus.CREATED)
  async createQr(
    @Param('studioId') studioId: string,
    @Param('bookingId') bookingId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.checkInsService.generateQrForBooking(studioId, bookingId, userId);
  }

  @Get('attendance')
  async getAttendance(
    @Param('studioId') studioId: string,
    @Param('bookingId') bookingId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.checkInsService.getBookingAttendance(studioId, bookingId, userId);
  }
}
