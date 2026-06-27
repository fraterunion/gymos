import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CheckInsService } from './check-ins.service';
import { DESK_CHECK_IN_ROLES } from '../auth/desk-roles';
import { ManualCheckInDto } from './dto/manual-check-in.dto';
import { QrCheckInDto } from './dto/qr-check-in.dto';

@Controller('studios/:studioId/check-ins')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class StudioCheckInsController {
  constructor(private readonly checkInsService: CheckInsService) {}

  @Post('qr')
  @UseGuards(RolesGuard)
  @Roles(...DESK_CHECK_IN_ROLES)
  @HttpCode(HttpStatus.CREATED)
  async checkInQr(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
    @Body() body: QrCheckInDto,
  ) {
    return this.checkInsService.checkInWithQr(studioId, userId, body.qrToken);
  }

  @Post('manual')
  @UseGuards(RolesGuard)
  @Roles(Role.FRONT_DESK, Role.STAFF, Role.ADMIN, Role.OWNER)
  @HttpCode(HttpStatus.CREATED)
  async checkInManual(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
    @Body() body: ManualCheckInDto,
  ) {
    return this.checkInsService.checkInManual(studioId, userId, body.bookingId);
  }
}
