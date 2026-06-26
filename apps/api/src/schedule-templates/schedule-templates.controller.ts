import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ScheduleTemplatesService } from './schedule-templates.service';
import { CreateScheduleTemplateDto } from './dto/create-schedule-template.dto';
import { UpdateScheduleTemplateDto } from './dto/update-schedule-template.dto';

@Controller('studios/:studioId/schedule-templates')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class ScheduleTemplatesController {
  constructor(private readonly service: ScheduleTemplatesService) {}

  @Get()
  list(@Param('studioId') studioId: string) {
    return this.service.list(studioId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN')
  create(
    @Param('studioId') studioId: string,
    @Body() dto: CreateScheduleTemplateDto,
  ) {
    return this.service.create(studioId, dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN')
  update(
    @Param('studioId') studioId: string,
    @Param('id') id: string,
    @Body() dto: UpdateScheduleTemplateDto,
  ) {
    return this.service.update(studioId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN')
  async remove(
    @Param('studioId') studioId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.service.remove(studioId, id);
  }
}
