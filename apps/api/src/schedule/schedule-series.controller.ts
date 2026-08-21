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
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ScheduleSeriesService } from './schedule-series.service';
import {
  CancelSeriesOccurrenceDto,
  CreateRecurringSeriesDto,
  EditSeriesOccurrenceDto,
} from './dto/schedule-series.dto';
import { FinishSeriesDto } from './dto/finish-series.dto';
import { ListScheduleSeriesQueryDto } from './dto/list-schedule-series-query.dto';

@Controller('studios/:studioId/schedule-series')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class ScheduleSeriesController {
  constructor(private readonly seriesService: ScheduleSeriesService) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  list(
    @Param('studioId') studioId: string,
    @Query() query: ListScheduleSeriesQueryDto,
  ) {
    return this.seriesService.listSeries(studioId, {
      status: query.status ?? 'all',
      search: query.search,
      instructorId: query.instructorId,
    });
  }

  @Post('preview')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  preview(
    @Param('studioId') studioId: string,
    @Body() dto: CreateRecurringSeriesDto,
  ) {
    return this.seriesService.previewCreate(studioId, dto);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('studioId') studioId: string,
    @Body() dto: CreateRecurringSeriesDto,
    @CurrentUser('sub') actorUserId: string,
  ) {
    return this.seriesService.createRecurringSeries(studioId, dto, actorUserId);
  }

  @Get('occurrences/:scheduledClassId/context')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  getContext(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
  ) {
    return this.seriesService.getOccurrenceSeriesContext(studioId, scheduledClassId);
  }

  @Post('occurrences/:scheduledClassId/edit-preview')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  editPreview(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
    @Body() dto: EditSeriesOccurrenceDto,
  ) {
    return this.seriesService.previewEditOccurrence(studioId, scheduledClassId, dto);
  }

  @Patch('occurrences/:scheduledClassId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  edit(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
    @Body() dto: EditSeriesOccurrenceDto,
    @CurrentUser('sub') actorUserId: string,
  ) {
    return this.seriesService.editOccurrence(
      studioId,
      scheduledClassId,
      dto,
      actorUserId,
    );
  }

  @Post('occurrences/:scheduledClassId/cancel-preview')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  cancelPreview(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
    @Body() dto: CancelSeriesOccurrenceDto,
  ) {
    return this.seriesService.previewCancelOccurrence(
      studioId,
      scheduledClassId,
      dto.scope,
    );
  }

  @Delete('occurrences/:scheduledClassId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
    @Body() dto: CancelSeriesOccurrenceDto,
    @CurrentUser('sub') actorUserId: string,
  ) {
    return this.seriesService.cancelOccurrence(
      studioId,
      scheduledClassId,
      dto.scope,
      actorUserId,
      dto.cancelReason,
      dto.confirmReservations,
    );
  }

  @Post(':seriesId/finish-preview')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  finishPreview(
    @Param('studioId') studioId: string,
    @Param('seriesId') seriesId: string,
    @Body() dto: FinishSeriesDto,
  ) {
    return this.seriesService.previewFinishSeries(studioId, seriesId, dto);
  }

  @Post(':seriesId/finish')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  finish(
    @Param('studioId') studioId: string,
    @Param('seriesId') seriesId: string,
    @Body() dto: FinishSeriesDto,
    @CurrentUser('sub') actorUserId: string,
  ) {
    return this.seriesService.finishSeries(studioId, seriesId, dto, actorUserId);
  }

  @Get(':seriesId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  getDetail(
    @Param('studioId') studioId: string,
    @Param('seriesId') seriesId: string,
  ) {
    return this.seriesService.getSeriesDetail(studioId, seriesId);
  }
}
