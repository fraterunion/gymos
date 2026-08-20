import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { DayPassClassAccessService } from './day-pass-class-access.service';
import { CreateDayPassClassAccessDto } from './dto/day-pass-class-access.dto';

@Controller('studios/:studioId/day-pass-class-access')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard)
@Roles(Role.OWNER, Role.ADMIN)
export class DayPassClassAccessController {
  constructor(private readonly service: DayPassClassAccessService) {}

  @Get()
  list(@Param('studioId') studioId: string) {
    return this.service.listAccess(studioId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  grant(
    @Param('studioId') studioId: string,
    @Body() dto: CreateDayPassClassAccessDto,
  ) {
    return this.service.grantAccess(studioId, dto.classTemplateId);
  }

  @Delete(':classTemplateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param('studioId') studioId: string,
    @Param('classTemplateId') classTemplateId: string,
  ) {
    await this.service.revokeAccess(studioId, classTemplateId);
  }
}
