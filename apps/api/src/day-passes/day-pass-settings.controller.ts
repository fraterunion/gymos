import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import type { RequestWithUser } from '../auth/interfaces/request-with-user.interface';
import { DayPassSettingsService } from './day-pass-settings.service';
import { UpdateDayPassSettingsDto } from './dto/update-day-pass-settings.dto';

@Controller('studios/:studioId/day-pass')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class DayPassSettingsController {
  constructor(private readonly settings: DayPassSettingsService) {}

  /** Member-facing catalog (price + availability). */
  @Get('catalog')
  getCatalog(@Param('studioId') studioId: string) {
    return this.settings.getCatalog(studioId);
  }

  @Get('settings')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  getSettings(@Param('studioId') studioId: string) {
    return this.settings.getSettings(studioId);
  }

  @Patch('settings')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  updateSettings(
    @Param('studioId') studioId: string,
    @Body() dto: UpdateDayPassSettingsDto,
    @Req() req: RequestWithUser,
  ) {
    return this.settings.updateSettings(studioId, dto, req.user.sub);
  }

  @Post('reconcile-stripe-price')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  reconcileStripePrice(@Param('studioId') studioId: string, @Req() req: RequestWithUser) {
    return this.settings.reconcileStripeSalePrice(studioId, req.user.sub);
  }
}
