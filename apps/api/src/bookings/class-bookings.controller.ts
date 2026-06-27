import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { BookingsService } from './bookings.service';
import { DESK_SCHEDULE_READ_ROLES } from '../auth/desk-roles';

@Controller('studios/:studioId/classes/:classId')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class ClassBookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post('bookings')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('studioId') studioId: string,
    @Param('classId') classId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.bookingsService.createBooking(studioId, classId, userId);
  }

  @Get('roster')
  @UseGuards(RolesGuard)
  @Roles(...DESK_SCHEDULE_READ_ROLES)
  roster(@Param('studioId') studioId: string, @Param('classId') classId: string) {
    return this.bookingsService.getRoster(studioId, classId);
  }
}
