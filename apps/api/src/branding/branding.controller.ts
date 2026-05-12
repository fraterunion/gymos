import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { BrandingService } from './branding.service';
import { UpdateBrandingDto } from './dto/update-branding.dto';

@Controller('studios/:studioId/branding')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard)
@Roles(Role.OWNER, Role.ADMIN)
export class BrandingController {
  constructor(private readonly brandingService: BrandingService) {}

  @Get()
  getOne(@Param('studioId') studioId: string) {
    return this.brandingService.getBrandingForStudio(studioId);
  }

  @Patch()
  update(@Param('studioId') studioId: string, @Body() dto: UpdateBrandingDto) {
    return this.brandingService.updateBranding(studioId, dto);
  }
}
