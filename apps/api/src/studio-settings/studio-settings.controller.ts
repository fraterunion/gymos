import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { UpdateBookingSettingsDto } from './dto/update-booking-settings.dto';
import { UpdateMobileConfigDto } from './dto/update-mobile-config.dto';
import { UpdateStudioBrandingDto } from './dto/update-studio-branding.dto';
import { UpdateStudioSettingsDto } from './dto/update-studio-settings.dto';
import { StudioSettingsService } from './studio-settings.service';

@Controller('studios/:studioId/settings')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard)
@Roles(Role.OWNER, Role.ADMIN)
export class StudioSettingsController {
  constructor(private readonly studioSettingsService: StudioSettingsService) {}

  @Get()
  getSettings(@Param('studioId') studioId: string) {
    return this.studioSettingsService.getSettings(studioId);
  }

  @Patch('general')
  patchGeneral(@Param('studioId') studioId: string, @Body() dto: UpdateStudioSettingsDto) {
    return this.studioSettingsService.updateGeneral(studioId, dto);
  }

  @Patch('branding')
  patchBranding(@Param('studioId') studioId: string, @Body() dto: UpdateStudioBrandingDto) {
    return this.studioSettingsService.updateBranding(studioId, dto);
  }

  @Patch('booking-rules')
  patchBookingRules(@Param('studioId') studioId: string, @Body() dto: UpdateBookingSettingsDto) {
    return this.studioSettingsService.updateBookingRules(studioId, dto);
  }

  @Patch('mobile-config')
  patchMobileConfig(@Param('studioId') studioId: string, @Body() dto: UpdateMobileConfigDto) {
    return this.studioSettingsService.updateMobileConfig(studioId, dto);
  }
}
