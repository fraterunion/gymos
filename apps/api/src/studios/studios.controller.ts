import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { UpdateStudioDto } from './dto/update-studio.dto';
import { StudiosService } from './studios.service';

@Controller('studios')
@UseGuards(JwtAuthGuard)
export class StudiosController {
  constructor(private readonly studiosService: StudiosService) {}

  @Get(':studioId')
  @UseGuards(StudioMemberGuard)
  getOne(@Param('studioId') studioId: string) {
    return this.studiosService.getStudioProfile(studioId);
  }

  @Patch(':studioId')
  @UseGuards(StudioMemberGuard, RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  update(@Param('studioId') studioId: string, @Body() dto: UpdateStudioDto) {
    return this.studiosService.updateStudio(studioId, dto);
  }
}
