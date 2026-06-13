import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { ScheduleQueryDto } from './dto/schedule-query.dto';
import {
  CancelScheduledClassDto,
  CreateScheduledClassDto,
  UpdateScheduledClassDto,
} from './dto/scheduled-class.dto';
import { ScheduleService } from './schedule.service';

@Controller('studios/:studioId/schedule')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class ScheduleController {
  constructor(private readonly scheduleService: ScheduleService) {}

  @Get()
  list(@Param('studioId') studioId: string, @Query() query: ScheduleQueryDto) {
    return this.scheduleService.listSchedule(studioId, query);
  }

  @Get('today-summary')
  @UseGuards(RolesGuard)
  @Roles(Role.STAFF, Role.INSTRUCTOR, Role.ADMIN, Role.OWNER)
  todaySummary(@Param('studioId') studioId: string) {
    return this.scheduleService.getTodaySummaryForStaff(studioId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  @HttpCode(HttpStatus.CREATED)
  create(@Param('studioId') studioId: string, @Body() dto: CreateScheduledClassDto) {
    return this.scheduleService.createScheduledClass(studioId, dto);
  }

  @Patch(':scheduledClassId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  update(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
    @Body() dto: UpdateScheduledClassDto,
  ) {
    return this.scheduleService.updateScheduledClass(studioId, scheduledClassId, dto);
  }

  @Delete(':scheduledClassId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
    @Optional() @Body() dto?: CancelScheduledClassDto,
  ) {
    await this.scheduleService.cancelScheduledClass(studioId, scheduledClassId, dto);
  }
}
