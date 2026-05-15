import { Body, Controller, ForbiddenException, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import type { JwtUser } from '../auth/interfaces/jwt-user.type';
import { PlatformOperatorService } from '../auth/platform-operator.service';
import { UpdateBookingSettingsDto } from './dto/update-booking-settings.dto';
import { UpdateMobileConfigDto } from './dto/update-mobile-config.dto';
import { UpdateStudioBrandingDto } from './dto/update-studio-branding.dto';
import { UpdateStudioSettingsDto } from './dto/update-studio-settings.dto';
import { StudioSettingsService } from './studio-settings.service';

type StudioSettingsResponse = Awaited<ReturnType<StudioSettingsService['getSettings']>>;

function redactPlatformOnlyFields(
  body: StudioSettingsResponse,
  isPlatformOperator: boolean,
): Omit<StudioSettingsResponse, 'mobile' | 'mobileWhiteLabelStatus'> | StudioSettingsResponse {
  if (isPlatformOperator) return body;
  const { mobile, mobileWhiteLabelStatus, ...rest } = body;
  void mobile;
  void mobileWhiteLabelStatus;
  return rest;
}

@Controller('studios/:studioId/settings')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard)
@Roles(Role.OWNER, Role.ADMIN)
export class StudioSettingsController {
  constructor(
    private readonly studioSettingsService: StudioSettingsService,
    private readonly platformOperatorService: PlatformOperatorService,
  ) {}

  @Get()
  async getSettings(@Param('studioId') studioId: string, @CurrentUser() user: JwtUser) {
    const body = await this.studioSettingsService.getSettings(studioId);
    return redactPlatformOnlyFields(body, this.platformOperatorService.isOperator(user.email));
  }

  @Patch('general')
  async patchGeneral(
    @Param('studioId') studioId: string,
    @Body() dto: UpdateStudioSettingsDto,
    @CurrentUser() user: JwtUser,
  ) {
    const body = await this.studioSettingsService.updateGeneral(studioId, dto);
    return redactPlatformOnlyFields(body, this.platformOperatorService.isOperator(user.email));
  }

  @Patch('branding')
  async patchBranding(
    @Param('studioId') studioId: string,
    @Body() dto: UpdateStudioBrandingDto,
    @CurrentUser() user: JwtUser,
  ) {
    const body = await this.studioSettingsService.updateBranding(studioId, dto);
    return redactPlatformOnlyFields(body, this.platformOperatorService.isOperator(user.email));
  }

  @Patch('booking-rules')
  async patchBookingRules(
    @Param('studioId') studioId: string,
    @Body() dto: UpdateBookingSettingsDto,
    @CurrentUser() user: JwtUser,
  ) {
    const body = await this.studioSettingsService.updateBookingRules(studioId, dto);
    return redactPlatformOnlyFields(body, this.platformOperatorService.isOperator(user.email));
  }

  @Patch('mobile-config')
  async patchMobileConfig(
    @Param('studioId') studioId: string,
    @Body() dto: UpdateMobileConfigDto,
    @CurrentUser() user: JwtUser,
  ) {
    if (!this.platformOperatorService.isOperator(user.email)) {
      throw new ForbiddenException(
        'Mobile and bundle configuration is restricted to FraterUnion platform operators.',
      );
    }
    return this.studioSettingsService.updateMobileConfig(studioId, dto);
  }
}
