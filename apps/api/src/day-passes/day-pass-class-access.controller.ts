import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
    @Req() req: RequestWithUser,
  ) {
    return this.service.grantAccess(studioId, dto.classTemplateId, req.user.sub);
  }

  @Delete(':classTemplateId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @Param('studioId') studioId: string,
    @Param('classTemplateId') classTemplateId: string,
    @Req() req: RequestWithUser,
  ) {
    await this.service.revokeAccess(studioId, classTemplateId, req.user.sub);
  }
}
